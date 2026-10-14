require("@nomicfoundation/hardhat-ethers");

// Testnet deployment reads secrets from the user's environment only (never from files):
//   CLIMATECHAIN_TESTNET_PK   private key of a testnet-only wallet
//   CLIMATECHAIN_RPC_URL      optional, defaults to a public Sepolia RPC
//   CLIMATECHAIN_BASE_RPC_URL optional, defaults to the public Base Sepolia RPC
const pk = process.env.CLIMATECHAIN_TESTNET_PK;

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  paths: { tests: "./test" },
  networks: {
    sepolia: {
      url: process.env.CLIMATECHAIN_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: pk ? [pk] : [],
    },
    baseSepolia: {
      url: process.env.CLIMATECHAIN_BASE_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: pk ? [pk] : [],
    },
  },
};
