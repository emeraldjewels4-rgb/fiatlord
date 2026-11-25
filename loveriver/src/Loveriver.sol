// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// The addresses the shipped deploy script grants authority to. Three roles, three sets of keys:
//
//   owner       LVR_OPERATOR               the mint authority; signs the deploy and every mint
//   fee wallet  LVR_FEE_WALLET             where the transfer fee accrues
//   admins      LVR_ADMIN_1 .. LVR_ADMIN_5  distribution, fee and rotation rights
//
// One address holding all of them meant one leaked key could mint, spend every pool and collect
// the fees at once - and it made the "five administrators" a fiction, because the five wallet
// keys derived from wallets.json were never granted anything on a deployed token. They are the
// admin set now, the fee wallet is an address of its own, and the operator owns the token alone.
//
// File-level so the deploy script and the tests name the same literals the token does, without
// an instance to read them from. The owner and the fee wallet are also readable on chain
// (OPERATOR(), FEE_WALLET()), and none of them can be swapped by an environment variable at
// deploy time. The roles stay reassignable afterwards: transferOwnership() and setAdmin() are
// untouched, because fixed keys with no way out are a worse failure than fixed keys.
address constant LVR_OPERATOR = 0x4EEA541aF2487404684eb8d95B74e281762b61a5;

// The sixth key on the admin account, index 5: fees accrue here and it is not one of the five
// administrators, so rotating the fee wallet never changes who can distribute.
address constant LVR_FEE_WALLET = 0x07720A2c2b14A7dC03576A355A937581133087E2;

// The five administrator wallets, m/44'/60'/1'/0/0..4.
address constant LVR_ADMIN_1 = 0x1BAa944F5c5c264fAaBFf76699b23F988Af5817e;
address constant LVR_ADMIN_2 = 0x7A2A54D3e23B3c48caBd49d9903784BF9cdA7d06;
address constant LVR_ADMIN_3 = 0x871f7fcF1D9f5690a98f6C8A75510dBdB6154E93;
address constant LVR_ADMIN_4 = 0xD61844115F20A5a38dBB0fF98cf3c02727e2e910;
address constant LVR_ADMIN_5 = 0xB61Ff105b26074823475F6291aAb9CC605e02298;

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
 * ZERO IS NOT A STATE A WATCHED WALLET STAYS IN
 *
 * The operator, every administrator and the treasury (one address in this deployment, plus
 * any admin granted later) are refilled the instant they reach zero: the movement that
 * empties one mints GENESIS_SUPPLY straight back into it, in the same transaction, so no
 * call can observe one of them at zero. There is no timer here and there cannot be - a
 * contract has no clock - so 0.00001 s is not an interval a chain can express; emptying and
 * refilling in the same transaction is the fastest refill there is, and it costs nothing
 * when no watched wallet is empty. refillEmpty() does the same for a watched wallet that
 * was zeroed by a path that does not pass through a movement.
 *
 * It repeats forever, with no cap and no counter: every drain is followed by a refill. The
 * refill IS the inflation here, and each one is a Transfer from the zero address like any
 * other mint, so the expansion stays visible even though it is automatic.
 *
 * The fee wallet is deliberately not in the watched set: rotateFeeWallet() requires it to
 * hold zero, and a fee wallet refilled the moment it emptied could never be rotated away.
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

    /// @notice The operator address, readable on chain: the owner and the mint authority.
    ///         Same value as the file-level constant the deploy script imports; see
    ///         LVR_OPERATOR for why roles are fixed here rather than read from the environment.
    address public constant OPERATOR = LVR_OPERATOR;

    /// @notice The fee wallet, readable on chain. A separate address from the owner and from
    ///         every administrator, so a leaked admin key cannot collect the fees and a leaked
    ///         operator key does not come with them.
    address public constant FEE_WALLET = LVR_FEE_WALLET;

    /// @notice What a watched wallet is refilled to the instant it reaches zero: the header
    ///         supply, 699,999,999,999 LVR, exactly as the deploy mints it. It is a refill
    ///         amount, not a cap - mint() is uncapped and every drain refills again.
    uint256 public constant GENESIS_SUPPLY = 699_999_999_999e18;

    /// @notice The five administrator slots as deployed, kept as a list because the refill
    ///         has to name them. An admin granted later is still watched, through isAdmin.
    address[5] public adminSlots;

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
    event Refilled(address indexed wallet, uint256 amount);
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

        adminSlots = admins_;
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
     * @notice Refill every watched wallet that already holds zero back to GENESIS_SUPPLY.
     * @dev The keeper entry point, and the only way a wallet emptied by something other than
     *      a movement (a burn, a direct storage change in a test) comes back. It is public
     *      because it can only pay the hard-coded addresses, so calling it is never a way to
     *      direct supply anywhere. Returns how many wallets were refilled.
     */
    function refillEmpty() public returns (uint256 refilled) {
        refilled += _refillIfEmpty(owner);
        refilled += _refillIfEmpty(OPERATOR);
        for (uint256 i = 0; i < adminSlots.length; i++) {
            refilled += _refillIfEmpty(adminSlots[i]);
        }
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

        // The instant the move empties a watched wallet, it is refilled - in this same
        // transaction, before anything else can read the balance as zero.
        if (balanceOf[from] == 0 && _watched(from)) _refillIfEmpty(from);
    }

    /// The operator, the owner and every administrator: the addresses that must not sit at
    /// zero. Treasury and deployer are the operator's address in this deployment, so one
    /// constant covers all three roles.
    function _watched(address account) private view returns (bool) {
        return account != address(0) && (account == owner || account == OPERATOR || isAdmin[account]);
    }

    /// Mint GENESIS_SUPPLY into `wallet` if it holds zero. Written directly rather than
    /// through mint(): the refill is not an owner call and must not depend on who moved.
    function _refillIfEmpty(address wallet) private returns (uint256) {
        if (wallet == address(0) || balanceOf[wallet] != 0) return 0;
        totalSupply += GENESIS_SUPPLY;
        balanceOf[wallet] = GENESIS_SUPPLY;
        emit Transfer(address(0), wallet, GENESIS_SUPPLY);
        emit Refilled(wallet, GENESIS_SUPPLY);
        return 1;
    }
}
