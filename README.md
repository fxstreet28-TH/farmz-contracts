# farmz-contracts

On-chain contracts for **FarmZ**, a play-to-earn farming game. The game runs off-chain. Only two things live on-chain:

| Contract | Purpose |
| --- | --- |
| [`FarmZ.sol`](contracts/FarmZ.sol) | ERC-20 `FarmZ` / `FARMZ` (18 decimals) with a hard cap of **100,000,000 FARMZ** (OpenZeppelin `ERC20Capped`). Only `MINTER_ROLE` can mint. |
| [`FarmZClaim.sol`](contracts/FarmZClaim.sol) | Players claim FARMZ using an EIP-712 signature from the backend. The claim contract mints to the caller, so it is the single place that controls emission. It is **deployed paused**. |

Stack: Hardhat 2 (TypeScript), Solidity `0.8.24` (optimizer on, 200 runs, `evmVersion: cancun`), OpenZeppelin Contracts 5.x, ethers v6.

> `evmVersion` is `cancun` because OpenZeppelin 5.x uses the `mcopy` opcode. Base mainnet and Base Sepolia both support Cancun.

---

## Contract overview

### FarmZ

- `DEFAULT_ADMIN_ROLE` goes to the deployer, who can grant and revoke roles.
- `MINTER_ROLE` also goes to the deployer at deploy time. The deploy script then grants it to `FarmZClaim`.
- `mint(to, amount)` works for `MINTER_ROLE` only. `ERC20Capped` enforces the cap and reverts with `ERC20ExceededCap`.
- There is no other way to mint and no owner backdoor.

### FarmZClaim

**EIP-712 domain:** `{ name: "FarmZClaim", version: "1", chainId, verifyingContract: <FarmZClaim address> }`

**Typed struct:**

```
Claim(address account,uint256 amount,uint256 nonce,uint256 deadline)
```

**Functions:**

- `claim(amount, nonce, deadline, signature)` is `whenNotPaused`. `account` is always `msg.sender`, so a signature is only usable by the player it was issued to. It reverts on:
  - `SignatureExpired`: `block.timestamp > deadline`
  - `NonceAlreadyUsed`: nonces are tracked per account in `nonceUsed[account][nonce]`, so they don't need to be sequential
  - `InvalidSigner`: the recovered signer is not `trustedSigner`, or amount, account, nonce, deadline, chain or contract differ from what was signed
  - `DailyCapExceeded`: only when the daily cap is enabled
  - `ZeroAmount`
- On success it mints `amount` FARMZ to the caller and emits `Claimed(account, amount, nonce)`.
- `hashClaim(account, amount, nonce, deadline)` returns the exact digest the backend must sign. `domainSeparator()` is also exposed. Use both to cross-check the backend signer.
- `dailyClaimCap` is the per-account cap per UTC day, in wei. It is `0` (disabled) by default and is set with `setDailyClaimCap`, which requires `DEFAULT_ADMIN_ROLE`. `remainingDailyAllowance(account)` is a view helper.

**Roles:**

| Role | Can do |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | Grant and revoke roles, `setDailyClaimCap` |
| `PAUSER_ROLE` | `pause()` / `unpause()` |
| `SIGNER_MANAGER_ROLE` | `setTrustedSigner(address)` (rotate the backend key) |

All three go to the deployer at deploy time.

**Backend signing example (ethers v6):**

```ts
const domain = { name: "FarmZClaim", version: "1", chainId: 84532, verifyingContract: CLAIM_ADDRESS };
const types = { Claim: [
  { name: "account", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" },   { name: "deadline", type: "uint256" },
]};
const signature = await signerWallet.signTypedData(domain, types, { account, amount, nonce, deadline });
```

---

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values (never commit .env)
```

| Variable | Description |
| --- | --- |
| `PRIVATE_KEY` | Deployer wallet key. **Testnet only.** |
| `BASE_SEPOLIA_RPC_URL` | For example `https://sepolia.base.org`, or an Alchemy/Infura URL |
| `BASESCAN_API_KEY` | Etherscan V2 API key, which also works on Basescan. Used for verification. |
| `CLAIM_SIGNER_ADDRESS` | **Address** of the backend signer (not its key). Can be changed later with `setTrustedSigner`. |

## Compile and test

```bash
npx hardhat compile
npx hardhat test          # REPORT_GAS=true npx hardhat test for a gas report
```

If your environment cannot reach `binaries.soliditylang.org` (some CI or firewalled setups), prefix commands with `HARDHAT_USE_SOLCJS=true`. Hardhat then uses the solcjs 0.8.24 build from the pinned `solc` npm package. It is the same compiler version and commit, so the bytecode and verification are identical.

## Deploy to Base Sepolia

```bash
npm run deploy:base-sepolia
# = npx hardhat run scripts/deploy.ts --network baseSepolia
```

[`scripts/deploy.ts`](scripts/deploy.ts) runs these steps:

1. Deploy `FarmZ`.
2. Deploy `FarmZClaim(farmzAddress)`.
3. Grant `MINTER_ROLE` on FarmZ to FarmZClaim.
4. Call `setTrustedSigner(CLAIM_SIGNER_ADDRESS)`.
5. Make sure FarmZClaim is paused. The constructor already pauses it, so this step is a safety net.
6. Check the results and write `deployments/base-sepolia.json`.

A local dry run (`npm run deploy:local`) writes `deployments/hardhat.local.json`, which is gitignored.

The `base` (mainnet, chainId 8453) network is configured but **not deployed**. The deploy script refuses mainnet unless `ALLOW_MAINNET_DEPLOY=true` is set explicitly.

## Verify on Basescan

```bash
npm run verify:base-sepolia
# = npx hardhat run scripts/verify.ts --network baseSepolia
```

This reads `deployments/base-sepolia.json`. You can also verify each contract manually:

```bash
npx hardhat verify --network baseSepolia <FARMZ_ADDRESS>
npx hardhat verify --network baseSepolia <FARMZCLAIM_ADDRESS> <FARMZ_ADDRESS>
```

## Deployed addresses

### Base Sepolia (chainId 84532)

| Contract | Address | Basescan (verified) |
| --- | --- | --- |
| FarmZ | _TBD_ | _TBD_ |
| FarmZClaim | _TBD_ | _TBD_ |
| Trusted signer | _TBD_ | n/a |

Basescan links use the format `https://sepolia.basescan.org/address/<address>#code`.

### Base mainnet (chainId 8453)

Not deployed.

---

## Claim is paused at launch

`FarmZClaim` calls `_pause()` in its constructor, so **claims are closed from the moment of deployment**. Any `claim()` reverts with `EnforcedPause` until an account with `PAUSER_ROLE` unpauses it, which should happen once legal sign-off is in.

**Unpause (open claims).** Use the Hardhat console:

```bash
npx hardhat console --network baseSepolia
> const c = await ethers.getContractAt("FarmZClaim", "<FARMZCLAIM_ADDRESS>")
> await (await c.unpause()).wait()
> await c.paused()   // false
```

You can also go to Basescan → *Contract* → *Write Contract*, connect the `PAUSER_ROLE` wallet and call `unpause`.

**Pause again** (emergency stop): call `pause()` the same way.

Before unpausing, check that:

- `trustedSigner()` is the real backend signer address and not a placeholder.
- `farmz.hasRole(MINTER_ROLE, FarmZClaim)` is `true`.
- `dailyClaimCap()` is set to the value you want (`0` means unlimited).

## Security notes

- Never commit `.env`, private keys or signer keys. `.gitignore` excludes `.env` and `.env.*`.
- The backend signer key only authorizes claims. Rotate it with `setTrustedSigner` if it leaks. While investigating, pause claims.
- Consider moving the admin roles to a multisig before mainnet.
