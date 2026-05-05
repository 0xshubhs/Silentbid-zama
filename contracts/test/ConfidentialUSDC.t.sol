// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ConfidentialUSDC} from "../src/ConfidentialUSDC.sol";

contract ConfidentialUSDCTest is FhevmTest {
    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;
    uint256 internal constant AUCTION_PK = 0xAA;

    MockUSDC internal usdc;
    ConfidentialUSDC internal cusdc;
    address internal alice;
    address internal bob;
    address internal auction;

    function setUp() public override {
        super.setUp();
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        auction = vm.addr(AUCTION_PK);

        usdc = new MockUSDC();
        cusdc = new ConfidentialUSDC(address(usdc));

        // Fund Alice and Bob with plain USDC.
        usdc.mint(alice, 1_000 * 1e6);
        usdc.mint(bob, 1_000 * 1e6);
    }

    function _wrap(address who, uint64 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(cusdc), amount);
        cusdc.wrap(amount);
        vm.stopPrank();
    }

    function _readBalance(uint256 pk, address account) internal returns (uint64) {
        euint64 bal = cusdc.balanceOf(account);
        bytes32 handle = euint64.unwrap(bal);
        bytes memory sig = signUserDecrypt(pk, address(cusdc));
        return uint64(userDecrypt(handle, account, address(cusdc), sig));
    }

    function test_wrap_creditsEncryptedBalance() public {
        _wrap(alice, 500 * 1e6);
        assertEq(usdc.balanceOf(address(cusdc)), 500 * 1e6);
        assertEq(_readBalance(ALICE_PK, alice), 500 * 1e6);
    }

    function test_wrap_RevertWhen_ZeroAmount() public {
        vm.startPrank(alice);
        usdc.approve(address(cusdc), 1e6);
        vm.expectRevert(ConfidentialUSDC.ZeroAmount.selector);
        cusdc.wrap(0);
        vm.stopPrank();
    }

    function test_transferEncrypted_movesBalance() public {
        _wrap(alice, 400 * 1e6);

        (externalEuint64 ext, bytes memory proof) = encryptUint64(150 * 1e6, alice, address(cusdc));
        vm.prank(alice);
        cusdc.transferEncryptedExternal(bob, ext, proof);

        assertEq(_readBalance(ALICE_PK, alice), 250 * 1e6);
        assertEq(_readBalance(BOB_PK, bob), 150 * 1e6);
    }

    function test_transferEncrypted_clampsToBalance() public {
        _wrap(alice, 100 * 1e6);
        // Try to transfer more than balance — should clamp, sending only 100
        (externalEuint64 ext, bytes memory proof) = encryptUint64(500 * 1e6, alice, address(cusdc));
        vm.prank(alice);
        cusdc.transferEncryptedExternal(bob, ext, proof);

        assertEq(_readBalance(ALICE_PK, alice), 0);
        assertEq(_readBalance(BOB_PK, bob), 100 * 1e6);
    }

    function test_approveAndPullViaTransferFromAllowance() public {
        _wrap(alice, 800 * 1e6);

        // Alice approves the auction contract to pull up to 250 cUSDC.
        (externalEuint64 ext, bytes memory proof) = encryptUint64(250 * 1e6, alice, address(cusdc));
        vm.prank(alice);
        cusdc.approve(auction, ext, proof);

        // Auction pulls into itself.
        vm.prank(auction);
        cusdc.transferFromAllowance(alice, auction);

        assertEq(_readBalance(ALICE_PK, alice), 550 * 1e6);
        // The auction can read its own balance because allowance flow grants ACL.
        assertEq(_readBalance(AUCTION_PK, auction), 250 * 1e6);
    }

    /// @dev Unwrap path: requestUnwrap debits balance correctly, the encrypted handle is
    ///      made publicly decryptable, and publicDecrypt produces a cleartext + KMS proof.
    ///      claimUnwrap is verified on real Sepolia FHEVM (real KMS signers); the mock
    ///      KMSVerifier in forge-fhevm v0.4.x doesn't always recognize the in-test signer
    ///      address registered via initializeFromEmptyProxy, so we stop short of the final
    ///      checkSignatures call here. Live integration covers the final hop.
    function test_unwrap_requestAndDecrypt() public {
        _wrap(alice, 700 * 1e6);

        (externalEuint64 ext, bytes memory proof) = encryptUint64(300 * 1e6, alice, address(cusdc));
        vm.prank(alice);
        uint256 unwrapId = cusdc.requestUnwrap(ext, proof, alice);

        // Alice's encrypted balance was debited by 300 (clamped from 300, balance 700).
        assertEq(_readBalance(ALICE_PK, alice), 400 * 1e6, "post-debit balance");

        (, euint64 encAmt, bool resolved) = cusdc.pendingUnwrap(unwrapId);
        assertFalse(resolved, "not resolved before claim");
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(encAmt);

        (uint256[] memory cleartexts,) = publicDecrypt(handles);
        assertEq(cleartexts[0], 300 * 1e6, "decrypted unwrap amount matches");
    }
}
