// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FarmZ} from "./FarmZ.sol";

/// @title FarmZClaim
/// @notice Settles off-chain FarmZ accruals on-chain. The backend signs an EIP-712 `Claim`
///         for a player; the player submits it here and receives freshly minted FARMZ.
/// @dev Requires MINTER_ROLE on the FarmZ token. Deployed in the paused state.
contract FarmZClaim is AccessControl, Pausable, EIP712 {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SIGNER_MANAGER_ROLE = keccak256("SIGNER_MANAGER_ROLE");

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address account,uint256 amount,uint256 nonce,uint256 deadline)");

    FarmZ public immutable farmz;

    /// @notice Address whose signatures authorize claims (backend signer).
    address public trustedSigner;

    /// @notice Max FARMZ (wei) a single account may claim per UTC day. 0 = no limit.
    uint256 public dailyClaimCap;

    /// @notice account => nonce => used
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    /// @notice account => day index (block.timestamp / 1 days) => amount claimed that day
    mapping(address => mapping(uint256 => uint256)) public claimedPerDay;

    event Claimed(address indexed account, uint256 amount, uint256 indexed nonce);
    event TrustedSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event DailyClaimCapUpdated(uint256 previousCap, uint256 newCap);

    error ZeroAddress();
    error ZeroAmount();
    error SignatureExpired(uint256 deadline);
    error NonceAlreadyUsed(address account, uint256 nonce);
    error InvalidSigner();
    error DailyCapExceeded(uint256 requested, uint256 remaining);

    constructor(address farmzToken) EIP712("FarmZClaim", "1") {
        if (farmzToken == address(0)) revert ZeroAddress();
        farmz = FarmZ(farmzToken);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(SIGNER_MANAGER_ROLE, msg.sender);

        // Claims are closed at launch; admin unpauses once legal sign-off is in.
        _pause();
    }

    // --------------------------------------------------------------------- claim

    /// @notice Claim `amount` FARMZ authorized by the trusted signer for msg.sender.
    function claim(uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);

        bytes32 digest = hashClaim(msg.sender, amount, nonce, deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered == address(0) || recovered != trustedSigner) {
            revert InvalidSigner();
        }

        nonceUsed[msg.sender][nonce] = true;
        _consumeDailyCap(msg.sender, amount);

        farmz.mint(msg.sender, amount);

        emit Claimed(msg.sender, amount, nonce);
    }

    /// @notice EIP-712 digest the backend must sign for a claim.
    function hashClaim(address account, uint256 amount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, amount, nonce, deadline)));
    }

    /// @notice Amount `account` can still claim today under the daily cap (max uint if disabled).
    function remainingDailyAllowance(address account) external view returns (uint256) {
        uint256 cap = dailyClaimCap;
        if (cap == 0) return type(uint256).max;
        uint256 used = claimedPerDay[account][block.timestamp / 1 days];
        return used >= cap ? 0 : cap - used;
    }

    /// @notice Domain separator (exposed for off-chain tooling).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------------- admin

    function setTrustedSigner(address newSigner) external onlyRole(SIGNER_MANAGER_ROLE) {
        if (newSigner == address(0)) revert ZeroAddress();
        emit TrustedSignerUpdated(trustedSigner, newSigner);
        trustedSigner = newSigner;
    }

    /// @notice Set per-account daily claim cap in FARMZ wei. 0 disables the cap.
    function setDailyClaimCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit DailyClaimCapUpdated(dailyClaimCap, newCap);
        dailyClaimCap = newCap;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ internal

    function _consumeDailyCap(address account, uint256 amount) internal {
        uint256 cap = dailyClaimCap;
        if (cap == 0) return;
        uint256 day = block.timestamp / 1 days;
        uint256 used = claimedPerDay[account][day];
        uint256 remaining = used >= cap ? 0 : cap - used;
        if (amount > remaining) revert DailyCapExceeded(amount, remaining);
        claimedPerDay[account][day] = used + amount;
    }
}
