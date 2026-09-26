import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const MAINNET_CHAIN_IDS = new Set([8453n]); // Base mainnet

// Live networks write `deployments/<name>.json` (committed); local ones write `*.local.json` (gitignored).
const DEPLOYMENT_FILES: Record<string, string> = {
  baseSepolia: "base-sepolia.json",
  base: "base.json",
};

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (MAINNET_CHAIN_IDS.has(chainId) && process.env.ALLOW_MAINNET_DEPLOY !== "true") {
    throw new Error(`Refusing to deploy to mainnet (chainId ${chainId}). Set ALLOW_MAINNET_DEPLOY=true once approved.`);
  }

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY in .env");

  let signerAddress = process.env.CLAIM_SIGNER_ADDRESS?.trim() ?? "";
  if (!signerAddress && isLocal) signerAddress = deployer.address;
  if (!ethers.isAddress(signerAddress) || signerAddress === ethers.ZeroAddress) {
    throw new Error(`CLAIM_SIGNER_ADDRESS is missing or invalid: "${signerAddress}"`);
  }
  signerAddress = ethers.getAddress(signerAddress);

  const confirmations = isLocal ? 1 : 2;
  console.log(`Network:   ${network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`Signer:    ${signerAddress}\n`);

  // 1. FarmZ
  const farmz = await ethers.deployContract("FarmZ");
  await farmz.waitForDeployment();
  const farmzDeployTx = farmz.deploymentTransaction();
  await farmzDeployTx?.wait(confirmations);
  const farmzAddress = await farmz.getAddress();
  console.log(`[1/5] FarmZ deployed:        ${farmzAddress}`);

  // 2. FarmZClaim
  const claim = await ethers.deployContract("FarmZClaim", [farmzAddress]);
  await claim.waitForDeployment();
  const claimDeployTx = claim.deploymentTransaction();
  await claimDeployTx?.wait(confirmations);
  const claimAddress = await claim.getAddress();
  console.log(`[2/5] FarmZClaim deployed:   ${claimAddress}`);

  // 3. MINTER_ROLE -> FarmZClaim
  const MINTER_ROLE = await farmz.MINTER_ROLE();
  await (await farmz.grantRole(MINTER_ROLE, claimAddress)).wait(confirmations);
  console.log(`[3/5] MINTER_ROLE granted to FarmZClaim`);

  // 4. Trusted signer
  await (await claim.setTrustedSigner(signerAddress)).wait(confirmations);
  console.log(`[4/5] Trusted signer set:    ${signerAddress}`);

  // 5. Pause (the constructor already pauses; this is a no-op safety net)
  if (!(await claim.paused())) {
    await (await claim.pause()).wait(confirmations);
  }
  console.log(`[5/5] FarmZClaim paused:     ${await claim.paused()}`);

  // Sanity checks
  if (!(await farmz.hasRole(MINTER_ROLE, claimAddress))) throw new Error("FarmZClaim is missing MINTER_ROLE");
  if ((await claim.trustedSigner()) !== signerAddress) throw new Error("Trusted signer mismatch");
  if (!(await claim.paused())) throw new Error("FarmZClaim is not paused");

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      FarmZ: {
        address: farmzAddress,
        txHash: farmzDeployTx?.hash ?? null,
        constructorArgs: [],
      },
      FarmZClaim: {
        address: claimAddress,
        txHash: claimDeployTx?.hash ?? null,
        constructorArgs: [farmzAddress],
      },
    },
    config: {
      trustedSigner: signerAddress,
      claimPaused: true,
      claimHasMinterRole: true,
      eip712Domain: { name: "FarmZClaim", version: "1", chainId: Number(chainId), verifyingContract: claimAddress },
    },
  };

  const file = DEPLOYMENT_FILES[network.name] ?? `${network.name}.local.json`;
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, file);
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");

  console.log(`\n========================================`);
  console.log(`FarmZ:       ${farmzAddress}`);
  console.log(`FarmZClaim:  ${claimAddress}`);
  console.log(`Written to:  deployments/${file}`);
  console.log(`========================================`);
  if (!isLocal) console.log(`\nVerify with: npx hardhat run scripts/verify.ts --network ${network.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
