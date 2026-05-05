// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Encrypted ERC20-like wrapper around a plaintext underlying (MockUSDC).
///         Balances and allowances are stored as `euint64` ciphertexts. The auction
///         contract pulls bidder funds via `transferFromAllowance` and refunds via
///         `transferEncrypted` — neither leaks the amount to anyone but the
///         participants in the FHE ACL.
///
///         Unwrap is two-step: a holder requests an unwrap, and the contract makes
///         the encrypted amount publicly decryptable. Anyone (typically the
///         recipient or a keeper) fetches the plaintext + KMS signatures from the
///         Zama relayer off-chain and calls `claimUnwrap` to receive the underlying.
contract ConfidentialUSDC is ZamaEthereumConfig {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    string public constant name = "Confidential USDC";
    string public constant symbol = "cUSDC";
    uint8 public constant decimals = 6;

    mapping(address => euint64) private _balances;
    mapping(address => mapping(address => euint64)) private _allowances;

    struct PendingUnwrap {
        address recipient;
        euint64 encAmount;
        bool resolved;
    }

    mapping(uint256 => PendingUnwrap) private _pendingUnwraps;
    uint256 public nextUnwrapId;

    event Wrapped(address indexed from, uint256 amount);
    event UnwrapRequested(uint256 indexed unwrapId, address indexed recipient, bytes32 handle);
    event UnwrapClaimed(uint256 indexed unwrapId, address indexed recipient, uint64 amount);
    event TransferEncrypted(address indexed from, address indexed to);
    event ApprovalEncrypted(address indexed owner, address indexed spender);

    error ZeroAddress();
    error ZeroAmount();
    error NotPending();
    error AlreadyResolved();

    constructor(address underlying_) {
        if (underlying_ == address(0)) revert ZeroAddress();
        underlying = IERC20(underlying_);
    }

    // --- Views ---

    function balanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    function allowance(address owner_, address spender) external view returns (euint64) {
        return _allowances[owner_][spender];
    }

    function pendingUnwrap(uint256 unwrapId)
        external
        view
        returns (address recipient, euint64 encAmount, bool resolved)
    {
        PendingUnwrap storage p = _pendingUnwraps[unwrapId];
        return (p.recipient, p.encAmount, p.resolved);
    }

    // --- Wrap: plain -> encrypted ---

    function wrap(uint64 amount) external {
        if (amount == 0) revert ZeroAmount();
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        euint64 enc = FHE.asEuint64(amount);
        _credit(msg.sender, enc);
        emit Wrapped(msg.sender, amount);
    }

    // --- Unwrap (two-step) ---

    function requestUnwrap(externalEuint64 encExtAmount, bytes calldata inputProof, address recipient)
        external
        returns (uint256 unwrapId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        euint64 amount = FHE.fromExternal(encExtAmount, inputProof);
        amount = _clampToBalance(msg.sender, amount);
        _debit(msg.sender, amount);

        unwrapId = nextUnwrapId++;
        _pendingUnwraps[unwrapId] = PendingUnwrap({
            recipient: recipient,
            encAmount: amount,
            resolved: false
        });

        FHE.allowThis(amount);
        FHE.makePubliclyDecryptable(amount);

        emit UnwrapRequested(unwrapId, recipient, FHE.toBytes32(amount));
    }

    /// @notice Submit the off-chain-fetched plaintext + KMS signatures to release the underlying.
    ///         Anyone can call this; the contract verifies the proof against the encrypted handle.
    function claimUnwrap(uint256 unwrapId, uint64 plainAmount, bytes calldata decryptionProof) external {
        PendingUnwrap storage p = _pendingUnwraps[unwrapId];
        if (p.recipient == address(0)) revert NotPending();
        if (p.resolved) revert AlreadyResolved();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(p.encAmount);
        bytes memory cleartexts = abi.encode(plainAmount);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        p.resolved = true;
        if (plainAmount > 0) underlying.safeTransfer(p.recipient, plainAmount);
        emit UnwrapClaimed(unwrapId, p.recipient, plainAmount);
    }

    // --- Encrypted transfer / approve ---

    function transferEncrypted(address to, euint64 encAmount) public returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        euint64 amount = _clampToBalance(msg.sender, encAmount);
        _debit(msg.sender, amount);
        _credit(to, amount);
        emit TransferEncrypted(msg.sender, to);
        return amount;
    }

    function transferEncryptedExternal(address to, externalEuint64 encExtAmount, bytes calldata inputProof)
        external
        returns (euint64)
    {
        euint64 enc = FHE.fromExternal(encExtAmount, inputProof);
        return transferEncrypted(to, enc);
    }

    function approve(address spender, externalEuint64 encExtAmount, bytes calldata inputProof) external {
        if (spender == address(0)) revert ZeroAddress();
        euint64 enc = FHE.fromExternal(encExtAmount, inputProof);
        _allowances[msg.sender][spender] = enc;
        FHE.allowThis(enc);
        FHE.allow(enc, msg.sender);
        FHE.allow(enc, spender);
        emit ApprovalEncrypted(msg.sender, spender);
    }

    /// @notice Pull funds from `from` based on the encrypted allowance granted to `msg.sender`.
    ///         Used by the auction to escrow bids. Returns the encrypted amount actually moved
    ///         (clamped to allowance and balance).
    function transferFromAllowance(address from, address to) external returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        euint64 allowed = _allowances[from][msg.sender];
        euint64 amount = _clampToBalance(from, allowed);
        euint64 remaining = FHE.sub(allowed, amount);
        _allowances[from][msg.sender] = remaining;
        FHE.allowThis(remaining);
        FHE.allow(remaining, from);
        FHE.allow(remaining, msg.sender);

        _debit(from, amount);
        _credit(to, amount);
        FHE.allow(amount, msg.sender);
        emit TransferEncrypted(from, to);
        return amount;
    }

    // --- Internals ---

    function _clampToBalance(address holder, euint64 desired) internal returns (euint64) {
        euint64 bal = _balances[holder];
        if (!FHE.isInitialized(bal)) {
            bal = FHE.asEuint64(0);
            _balances[holder] = bal;
            FHE.allowThis(bal);
        }
        ebool fits = FHE.le(desired, bal);
        return FHE.select(fits, desired, bal);
    }

    function _debit(address from, euint64 amount) internal {
        euint64 bal = _balances[from];
        if (!FHE.isInitialized(bal)) bal = FHE.asEuint64(0);
        bal = FHE.sub(bal, amount);
        _balances[from] = bal;
        FHE.allowThis(bal);
        FHE.allow(bal, from);
    }

    function _credit(address to, euint64 amount) internal {
        euint64 bal = _balances[to];
        if (!FHE.isInitialized(bal)) bal = FHE.asEuint64(0);
        bal = FHE.add(bal, amount);
        _balances[to] = bal;
        FHE.allowThis(bal);
        FHE.allow(bal, to);
    }
}
