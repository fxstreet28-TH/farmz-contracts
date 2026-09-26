import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

const SOLC_VERSION = "0.8.24";

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`] : [];

// Opt-in: compile with the solcjs build shipped in the `solc` npm package instead of
// downloading from binaries.soliditylang.org (for firewalled CI / sandboxes).
// Same compiler version + commit, so bytecode and Basescan verification are unaffected.
if (process.env.HARDHAT_USE_SOLCJS === "true") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
    if (args.solcVersion !== SOLC_VERSION) return runSuper();
    const solcPath = require.resolve("solc/soljson.js");
    const solc = require("solc");
    return {
      compilerPath: solcPath,
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version().replace(/\.Emscripten\.clang$/, ""),
    };
  });
}

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun", // required by OpenZeppelin 5.x (mcopy); supported on Base
    },
  },
  networks: {
    hardhat: {},
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // Mainnet config is prepared but MUST NOT be deployed to yet (see scripts/deploy.ts guard).
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },
  },
  etherscan: {
    // Etherscan V2 multichain key (works for Basescan).
    apiKey: process.env.BASESCAN_API_KEY || "",
  },
  sourcify: { enabled: false },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
};

export default config;
