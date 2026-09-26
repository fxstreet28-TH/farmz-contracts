import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { Signer } from "ethers";
import type { FarmZClaim } from "../typechain-types";

const CLAIM_TYPES = {
  Claim: [
    { name: "account", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function signClaim(
  signer: Signer,
  claimContract: FarmZClaim,
  value: { account: string; amount: bigint; nonce: bigint; deadline: bigint },
) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "FarmZClaim",
    version: "1",
    chainId,
    verifyingContract: await claimContract.getAddress(),
  };
  return signer.signTypedData(domain, CLAIM_TYPES, value);
}

describe("FarmZClaim", () => {
  async function deployFixture() {
    const [deployer, backendSigner, alice, bob, attacker, pauser] = await ethers.getSigners();

    const farmz = await ethers.deployContract("FarmZ");
    const claim = await ethers.deployContract("FarmZClaim", [await farmz.getAddress()]);

    await farmz.grantRole(await farmz.MINTER_ROLE(), await claim.getAddress());
    await claim.setTrustedSigner(backendSigner.address);

    return { farmz, claim, deployer, backendSigner, alice, bob, attacker, pauser };
  }

  async function unpausedFixture() {
    const f = await deployFixture();
    await f.claim.unpause();
    return f;
  }

  async function deadlineIn(seconds: number) {
    return BigInt((await time.latest()) + seconds);
  }

  describe("deployment", () => {
    it("starts paused with roles on deployer and token wired", async () => {
      const { farmz, claim, deployer } = await loadFixture(deployFixture);
      expect(await claim.paused()).to.be.true;
      expect(await claim.farmz()).to.equal(await farmz.getAddress());
      for (const role of [
        await claim.DEFAULT_ADMIN_ROLE(),
        await claim.PAUSER_ROLE(),
        await claim.SIGNER_MANAGER_ROLE(),
      ]) {
        expect(await claim.hasRole(role, deployer.address)).to.be.true;
      }
      expect(await farmz.hasRole(await farmz.MINTER_ROLE(), await claim.getAddress())).to.be.true;
      expect(await claim.dailyClaimCap()).to.equal(0n);
    });

    it("rejects zero token address", async () => {
      const factory = await ethers.getContractFactory("FarmZClaim");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("hashClaim matches ethers TypedDataEncoder", async () => {
      const { claim, alice } = await loadFixture(deployFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const value = { account: alice.address, amount: 123n, nonce: 7n, deadline: 999n };
      const expected = ethers.TypedDataEncoder.hash(
        { name: "FarmZClaim", version: "1", chainId, verifyingContract: await claim.getAddress() },
        CLAIM_TYPES,
        value,
      );
      expect(await claim.hashClaim(value.account, value.amount, value.nonce, value.deadline)).to.equal(expected);
    });
  });

  describe("claim", () => {
    it("valid signature mints tokens to the caller and emits Claimed", async () => {
      const { farmz, claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const amount = ethers.parseEther("250");
      const nonce = 1n;
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount, nonce, deadline });

      await expect(claim.connect(alice).claim(amount, nonce, deadline, sig))
        .to.emit(claim, "Claimed")
        .withArgs(alice.address, amount, nonce);

      expect(await farmz.balanceOf(alice.address)).to.equal(amount);
      expect(await farmz.totalSupply()).to.equal(amount);
      expect(await claim.nonceUsed(alice.address, nonce)).to.be.true;
    });

    it("signature from the wrong signer reverts", async () => {
      const { claim, attacker, alice } = await loadFixture(unpausedFixture);
      const amount = ethers.parseEther("1");
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(attacker, claim, { account: alice.address, amount, nonce: 1n, deadline });

      await expect(claim.connect(alice).claim(amount, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });

    it("malformed signature reverts", async () => {
      const { claim, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      await expect(claim.connect(alice).claim(1n, 1n, deadline, "0x1234")).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });

    it("replaying the same nonce reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const amount = ethers.parseEther("10");
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount, nonce: 42n, deadline });

      await claim.connect(alice).claim(amount, 42n, deadline, sig);
      await expect(claim.connect(alice).claim(amount, 42n, deadline, sig))
        .to.be.revertedWithCustomError(claim, "NonceAlreadyUsed")
        .withArgs(alice.address, 42n);
    });

    it("nonces are scoped per account", async () => {
      const { farmz, claim, backendSigner, alice, bob } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      const sigA = await signClaim(backendSigner, claim, { account: alice.address, amount: 5n, nonce: 1n, deadline });
      const sigB = await signClaim(backendSigner, claim, { account: bob.address, amount: 6n, nonce: 1n, deadline });
      await claim.connect(alice).claim(5n, 1n, deadline, sigA);
      await claim.connect(bob).claim(6n, 1n, deadline, sigB);
      expect(await farmz.balanceOf(alice.address)).to.equal(5n);
      expect(await farmz.balanceOf(bob.address)).to.equal(6n);
    });

    it("expired deadline reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const amount = ethers.parseEther("1");
      const deadline = await deadlineIn(60);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount, nonce: 1n, deadline });

      await time.increaseTo(deadline + 1n);
      await expect(claim.connect(alice).claim(amount, 1n, deadline, sig))
        .to.be.revertedWithCustomError(claim, "SignatureExpired")
        .withArgs(deadline);
    });

    it("claim exactly at the deadline succeeds", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(60);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await time.setNextBlockTimestamp(deadline);
      await expect(claim.connect(alice).claim(1n, 1n, deadline, sig)).to.emit(claim, "Claimed");
    });

    it("amount different from the signed amount reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, {
        account: alice.address,
        amount: ethers.parseEther("1"),
        nonce: 1n,
        deadline,
      });
      await expect(
        claim.connect(alice).claim(ethers.parseEther("1000"), 1n, deadline, sig),
      ).to.be.revertedWithCustomError(claim, "InvalidSigner");
    });

    it("account different from the signed account (front-run / stolen signature) reverts", async () => {
      const { claim, backendSigner, alice, attacker } = await loadFixture(unpausedFixture);
      const amount = ethers.parseEther("1");
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount, nonce: 1n, deadline });
      await expect(claim.connect(attacker).claim(amount, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });

    it("nonce or deadline different from the signed values reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 2n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
      await expect(claim.connect(alice).claim(1n, 1n, deadline + 1n, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });

    it("signature for a different chain / contract reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      const sig = await backendSigner.signTypedData(
        { name: "FarmZClaim", version: "1", chainId: 8453n, verifyingContract: await claim.getAddress() },
        CLAIM_TYPES,
        { account: alice.address, amount: 1n, nonce: 1n, deadline },
      );
      await expect(claim.connect(alice).claim(1n, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });

    it("zero amount reverts", async () => {
      const { claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount: 0n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(0n, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "ZeroAmount",
      );
    });

    it("reverts when claim would exceed the token cap", async () => {
      const { farmz, claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      const cap = await farmz.cap();
      await farmz.mint(alice.address, cap);
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 1n, deadline, sig)).to.be.revertedWithCustomError(
        farmz,
        "ERC20ExceededCap",
      );
    });

    it("reverts if FarmZClaim lacks MINTER_ROLE", async () => {
      const { farmz, claim, backendSigner, alice } = await loadFixture(unpausedFixture);
      await farmz.revokeRole(await farmz.MINTER_ROLE(), await claim.getAddress());
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 1n, deadline, sig)).to.be.revertedWithCustomError(
        farmz,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("pause", () => {
    it("claim reverts while paused; succeeds after unpause", async () => {
      const { farmz, claim, backendSigner, alice } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("3");
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(backendSigner, claim, { account: alice.address, amount, nonce: 1n, deadline });

      await expect(claim.connect(alice).claim(amount, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "EnforcedPause",
      );

      await expect(claim.unpause()).to.emit(claim, "Unpaused");
      await claim.connect(alice).claim(amount, 1n, deadline, sig);
      expect(await farmz.balanceOf(alice.address)).to.equal(amount);
    });

    it("only PAUSER_ROLE can pause/unpause", async () => {
      const { claim, attacker, pauser } = await loadFixture(deployFixture);
      const PAUSER = await claim.PAUSER_ROLE();
      await expect(claim.connect(attacker).unpause())
        .to.be.revertedWithCustomError(claim, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, PAUSER);

      await claim.grantRole(PAUSER, pauser.address);
      await claim.connect(pauser).unpause();
      expect(await claim.paused()).to.be.false;
      await expect(claim.connect(attacker).pause()).to.be.revertedWithCustomError(
        claim,
        "AccessControlUnauthorizedAccount",
      );
      await claim.connect(pauser).pause();
      expect(await claim.paused()).to.be.true;
    });
  });

  describe("trusted signer management", () => {
    it("SIGNER_MANAGER_ROLE can rotate the signer; old signer stops working", async () => {
      const { claim, backendSigner, alice, bob } = await loadFixture(unpausedFixture);
      await expect(claim.setTrustedSigner(bob.address))
        .to.emit(claim, "TrustedSignerUpdated")
        .withArgs(backendSigner.address, bob.address);
      expect(await claim.trustedSigner()).to.equal(bob.address);

      const deadline = await deadlineIn(3600);
      const oldSig = await signClaim(backendSigner, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 1n, deadline, oldSig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
      const newSig = await signClaim(bob, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 1n, deadline, newSig)).to.emit(claim, "Claimed");
    });

    it("accounts without SIGNER_MANAGER_ROLE cannot change the signer", async () => {
      const { claim, attacker } = await loadFixture(deployFixture);
      await expect(claim.connect(attacker).setTrustedSigner(attacker.address))
        .to.be.revertedWithCustomError(claim, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, await claim.SIGNER_MANAGER_ROLE());
    });

    it("a granted SIGNER_MANAGER_ROLE holder can change the signer", async () => {
      const { claim, bob, alice } = await loadFixture(deployFixture);
      await claim.grantRole(await claim.SIGNER_MANAGER_ROLE(), bob.address);
      await claim.connect(bob).setTrustedSigner(alice.address);
      expect(await claim.trustedSigner()).to.equal(alice.address);
    });

    it("rejects zero address signer", async () => {
      const { claim } = await loadFixture(deployFixture);
      await expect(claim.setTrustedSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(claim, "ZeroAddress");
    });

    it("claims fail when no signer is configured", async () => {
      const [, someone, alice] = await ethers.getSigners();
      const farmz = await ethers.deployContract("FarmZ");
      const claim = await ethers.deployContract("FarmZClaim", [await farmz.getAddress()]);
      await farmz.grantRole(await farmz.MINTER_ROLE(), await claim.getAddress());
      await claim.unpause();
      const deadline = await deadlineIn(3600);
      const sig = await signClaim(someone, claim, { account: alice.address, amount: 1n, nonce: 1n, deadline });
      await expect(claim.connect(alice).claim(1n, 1n, deadline, sig)).to.be.revertedWithCustomError(
        claim,
        "InvalidSigner",
      );
    });
  });

  describe("daily cap", () => {
    it("is disabled by default (unlimited)", async () => {
      const { claim, alice } = await loadFixture(deployFixture);
      expect(await claim.remainingDailyAllowance(alice.address)).to.equal(ethers.MaxUint256);
    });

    it("only admin can set the cap", async () => {
      const { claim, attacker } = await loadFixture(deployFixture);
      await expect(claim.connect(attacker).setDailyClaimCap(1n)).to.be.revertedWithCustomError(
        claim,
        "AccessControlUnauthorizedAccount",
      );
      await expect(claim.setDailyClaimCap(100n)).to.emit(claim, "DailyClaimCapUpdated").withArgs(0n, 100n);
    });

    it("enforces per-account per-day limit and resets the next day", async () => {
      const { claim, backendSigner, alice, bob } = await loadFixture(unpausedFixture);
      await claim.setDailyClaimCap(100n);
      const deadline = await deadlineIn(3 * 86400);
      const sign = (account: string, amount: bigint, nonce: bigint) =>
        signClaim(backendSigner, claim, { account, amount, nonce, deadline });

      await claim.connect(alice).claim(60n, 1n, deadline, await sign(alice.address, 60n, 1n));
      expect(await claim.remainingDailyAllowance(alice.address)).to.equal(40n);

      await expect(claim.connect(alice).claim(41n, 2n, deadline, await sign(alice.address, 41n, 2n)))
        .to.be.revertedWithCustomError(claim, "DailyCapExceeded")
        .withArgs(41n, 40n);

      // Other accounts are unaffected.
      await claim.connect(bob).claim(100n, 1n, deadline, await sign(bob.address, 100n, 1n));

      await claim.connect(alice).claim(40n, 3n, deadline, await sign(alice.address, 40n, 3n));
      expect(await claim.remainingDailyAllowance(alice.address)).to.equal(0n);

      await time.increase(86400);
      expect(await claim.remainingDailyAllowance(alice.address)).to.equal(100n);
      await claim.connect(alice).claim(41n, 2n, deadline, await sign(alice.address, 41n, 2n));
    });
  });
});
