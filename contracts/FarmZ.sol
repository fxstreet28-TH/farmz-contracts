// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title FarmZ (FARMZ)
/// @notice Hard currency of the FarmZ game. Supply is hard-capped at 100,000,000 FARMZ.
/// @dev Minting is restricted to MINTER_ROLE (intended holder: FarmZClaim). The cap is
///      enforced by OpenZeppelin's ERC20Capped; there is no other way to create tokens.
contract FarmZ is ERC20, ERC20Capped, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public constant MAX_SUPPLY = 100_000_000 ether; // 100M * 10^18

    constructor() ERC20("FarmZ", "FARMZ") ERC20Capped(MAX_SUPPLY) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    /// @notice Mint `amount` FARMZ to `to`. Reverts if the cap would be exceeded.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Capped) {
        super._update(from, to, value);
    }
}
