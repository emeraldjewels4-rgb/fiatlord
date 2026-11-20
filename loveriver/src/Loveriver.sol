// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Loveriver (LVR)
 *
 * SUPPLY IS INFLATIONARY, DELIBERATELY
 *
 * mint() has no cap. The owner may issue any amount, at any time, for as long as the
 * contract exists. That is what "fiat rules" means once written as code: the issuer
 * decides the quantity. There is no pretense otherwise - every mint emits a Transfer
 * from the zero address, so the expansion is auditable even though it is unbounded. A
 * token with unlimited supply cannot be described as non-inflationary; this one is not.
 *
 * FEES
 *
 * The fee is charged in LVR, on the transfer, as feeBps of the amount moved. No pool,
 * no oracle, no second asset: the fee comes out of the token being moved, which is the
 * only part of the original design that genuinely needs no liquidity. Moving tokens
 * out of the fee wallet is free, so it can always be emptied.
 *
 * THE FEE WALLET IS ROTATED, NOT REUSED
 *
 * claimFeeWallet() empties it into a treasury address. rotateFeeWallet() only accepts a
 * new wallet once the current one holds zero. burnFees() is the step that actually
 * removes those tokens from totalSupply - rotating alone would only move them, and
 * moving tokens does not make them disappear.
 *
 * Only the standard Transfer and Approval events are emitted; a mint is a Transfer from
 * the zero address and a burn is a Transfer to it, so anything watching transfers
 * already sees both.
 */
contract Loveriver {
    string public constant name = "Loveriver";
    string public constant symbol = "LVR";
    uint8 public constant decimals = 18;

    /// @notice Fees are a fraction of the amount moved, in basis points (1% = 100).
    uint256 public constant MAX_FEE_BPS = 500;

    address public owner;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isAdmin;

    /// @notice Where fees accumulate until they are claimed, burned or rotated away.
    address public feeWallet;

    /// @notice Current fee, in basis points of every transfer.
    uint256 public feeBps;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event FeeWalletRotated(address indexed previous, address indexed next);
    event OwnerChanged(address indexed previous, address indexed next);
    event AdminChanged(address indexed account, bool allowed);

    error NotOwner(address caller);
    error NotAdmin(address caller);
    error ZeroAddress();
    error InsufficientBalance(address holder, uint256 balance, uint256 needed);
    error InsufficientAllowance(address holder, address spender, uint256 allowed, uint256 needed);
    error FeeTooHigh(uint256 requested, uint256 maximum);
    error FeeWalletNotEmpty(address wallet, uint256 balance);
    error RangeOutOfBounds(uint256 start, uint256 end, uint256 length);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender] && msg.sender != owner) revert NotAdmin(msg.sender);
        _;
    }

    /**
     * @param owner_     the mint authority
     * @param admins_    the administrators: fee, distribution and rotation
     * @param feeWallet_ the first address that collects fees
     * @param feeBps_    initial fee in basis points
     */
    constructor(address owner_, address[5] memory admins_, address feeWallet_, uint256 feeBps_) {
        if (owner_ == address(0) || feeWallet_ == address(0)) revert ZeroAddress();

        owner = owner_;
        feeWallet = feeWallet_;
        _setFeeBps(feeBps_);

        for (uint256 i = 0; i < admins_.length; i++) {
            if (admins_[i] == address(0)) revert ZeroAddress();
            isAdmin[admins_[i]] = true;
            emit AdminChanged(admins_[i], true);
        }
        emit OwnerChanged(address(0), owner_);
    }

    // ---------------------------------------------------------------- supply

    /**
     * @notice Issue more LVR. No cap: this is the inflation, and it is deliberate.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /**
     * @notice Destroy the fees that have collected, so supply actually falls.
     * @dev The only path in this contract that reduces totalSupply.
     */
    function burnFees() external onlyAdmin returns (uint256 burned) {
        burned = balanceOf[feeWallet];
        if (burned == 0) return 0;
        balanceOf[feeWallet] = 0;
        totalSupply -= burned;
        emit Transfer(feeWallet, address(0), burned);
    }

    // ------------------------------------------------------------ transfers

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value, true);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(from, msg.sender, allowed, value);
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _move(from, to, value, true);
        return true;
    }

    // --------------------------------------------------------- distribution

    /**
     * @notice Fill one contiguous slice of a wallet list with the same amount each.
     * @dev The interval form: filling 0..999 a hundred at a time means start=0,end=100
     *      then start=100,end=200, and so on. Distribution is not a trade, so no fee is
     *      charged, and the sender pays out of its own balance - nothing is minted.
     *      Any bad entry (a zero recipient, or a balance that runs out mid-slice)
     *      reverts the entire call, so a batch is never left half filled.
     */
    function distributeRange(
        address[] calldata to,
        uint256 perWallet,
        uint256 start,
        uint256 end
    ) external onlyAdmin {
        if (!(start <= end && end <= to.length)) revert RangeOutOfBounds(start, end, to.length);
        for (uint256 i = start; i < end; i++) {
            _move(msg.sender, to[i], perWallet, false);
        }
    }

    // ------------------------------------------------------------- fee admin

    function setFeeBps(uint256 next) external onlyAdmin {
        _setFeeBps(next);
    }

    /**
     * @notice Move the collected fees out to a treasury address, leaving the wallet empty.
     */
    function claimFeeWallet(address treasury) external onlyAdmin {
        if (treasury == address(0)) revert ZeroAddress();
        uint256 held = balanceOf[feeWallet];
        if (held == 0) return;
        _move(feeWallet, treasury, held, false);
    }

    /**
     * @notice Replace the fee collector. The old one must already be empty.
     * @dev Requiring an empty wallet is what stops a rotation being used to quietly
     *      leave unaccounted fees behind in an address nobody watches.
     */
    function rotateFeeWallet(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        uint256 held = balanceOf[feeWallet];
        if (held != 0) revert FeeWalletNotEmpty(feeWallet, held);
        address previous = feeWallet;
        feeWallet = next;
        emit FeeWalletRotated(previous, next);
    }

    // ------------------------------------------------------------ ownership

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = next;
        emit OwnerChanged(previous, next);
    }

    function setAdmin(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isAdmin[account] = allowed;
        emit AdminChanged(account, allowed);
    }

    // -------------------------------------------------------------- internal

    function _setFeeBps(uint256 next) private {
        if (next > MAX_FEE_BPS) revert FeeTooHigh(next, MAX_FEE_BPS);
        feeBps = next;
    }

    /**
     * @dev One movement of value. `chargeFee` is false for distribution; the fee is
     *      never charged into or out of the fee wallet itself.
     */
    function _move(address from, address to, uint256 amount, bool chargeFee) private {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);

        uint256 fee = 0;
        if (chargeFee && feeBps != 0 && from != feeWallet && to != feeWallet) {
            fee = (amount * feeBps) / 10_000;
        }

        balanceOf[from] = balance - amount;
        balanceOf[to] += amount - fee;
        emit Transfer(from, to, amount - fee);

        if (fee != 0) {
            balanceOf[feeWallet] += fee;
            emit Transfer(from, feeWallet, fee);
        }
    }
}
