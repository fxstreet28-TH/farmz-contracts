import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("FarmZ", () => {
  async function deployFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const farmz = await ethers.deployContract("FarmZ");
    return { farmz, deployer, alice, bob };
  }

  it("has correct metadata and cap", async () => {
    const { farmz } = await loadFixture(deployFixture);
    expect(await farmz.name()).to.equal("FarmZ");
    expect(await farmz.symbol()).to.equal("FARMZ");
    expect(await farmz.decimals()).to.equal(18);
    expect(await farmz.cap()).to.equal(ethers.parseEther("100000000"));
    expect(await farmz.MAX_SUPPLY()).to.equal(ethers.parseEther("100000000"));
    expect(await farmz.totalSupply()).to.equal(0n);
  });

  it("grants DEFAULT_ADMIN_ROLE and MINTER_ROLE to the deployer", async () => {
    const { farmz, deployer } = await loadFixture(deployFixture);
    expect(await farmz.hasRole(await farmz.DEFAULT_ADMIN_ROLE(), deployer.address)).to.be.true;
    expect(await farmz.hasRole(await farmz.MINTER_ROLE(), deployer.address)).to.be.true;
  });

  it("MINTER_ROLE can mint", async () => {
    const { farmz, alice } = await loadFixture(deployFixture);
    await expect(farmz.mint(alice.address, 1000n)).to.changeTokenBalance(farmz, alice, 1000n);
  });

  it("non-minter cannot mint", async () => {
    const { farmz, alice } = await loadFixture(deployFixture);
    await expect(farmz.connect(alice).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(farmz, "AccessControlUnauthorizedAccount")
      .withArgs(alice.address, await farmz.MINTER_ROLE());
  });

  it("minting up to the cap succeeds, beyond the cap reverts", async () => {
    const { farmz, alice } = await loadFixture(deployFixture);
    const cap = await farmz.cap();
    await farmz.mint(alice.address, cap);
    expect(await farmz.totalSupply()).to.equal(cap);
    await expect(farmz.mint(alice.address, 1n))
      .to.be.revertedWithCustomError(farmz, "ERC20ExceededCap")
      .withArgs(cap + 1n, cap);
  });

  it("a single mint above the cap reverts", async () => {
    const { farmz, alice } = await loadFixture(deployFixture);
    const cap = await farmz.cap();
    await expect(farmz.mint(alice.address, cap + 1n)).to.be.revertedWithCustomError(farmz, "ERC20ExceededCap");
  });

  it("admin can grant and revoke MINTER_ROLE", async () => {
    const { farmz, alice, bob } = await loadFixture(deployFixture);
    const MINTER = await farmz.MINTER_ROLE();
    await farmz.grantRole(MINTER, alice.address);
    await farmz.connect(alice).mint(bob.address, 5n);
    await farmz.revokeRole(MINTER, alice.address);
    await expect(farmz.connect(alice).mint(bob.address, 5n)).to.be.revertedWithCustomError(
      farmz,
      "AccessControlUnauthorizedAccount",
    );
  });
});
