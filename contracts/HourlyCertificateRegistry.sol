// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HourlyCertificateRegistry
/// @notice Renewable energy certificates issued per generator per hour (1 unit = 1 kWh).
/// Several authorized issuers write into ONE shared retirement state. A certificate can be
/// transferred once (plant account to buyer), retired once, only by the wallet bound to the
/// consuming company, and only against metered consumption in the SAME hour. Anyone can
/// recompute how much of a company's electricity was matched hour by hour from chain state.
/// @dev Certificate id = generatorId << 64 | hourIndex, where hourIndex = unix seconds / 3600.
/// Demo contract on a public testnet. Not audited. Not upgradeable.
contract HourlyCertificateRegistry {
    struct Generator {
        string name;
        address owner; // plant account that receives new certificates
        address issuer; // the authorized issuer that registered this plant
        uint16 commissionYear;
        bool exists;
    }

    /// Registry operator: adds and removes issuers, binds companies to wallets, writes metered use.
    /// In a real deployment these duties would be split (meter data from the grid operator,
    /// the issuer list under multi-party governance).
    address public immutable operator;

    mapping(address => bool) public isIssuer;
    mapping(uint32 => Generator) public generators;
    mapping(bytes32 => address) public consumerWallet; // company id => the only wallet allowed to retire / anchor for it

    mapping(uint256 => mapping(address => uint256)) public balanceOf; // id => holder => kWh
    mapping(uint256 => uint256) public issued; // id => kWh
    mapping(uint256 => uint256) public retiredOf; // id => kWh

    // company => hourIndex => kWh
    mapping(bytes32 => mapping(uint64 => uint256)) public consumption;
    mapping(bytes32 => mapping(uint64 => uint256)) public matched;

    // claim hash => block timestamp when anchored (0 = never)
    mapping(bytes32 => uint256) public claimAnchoredAt;

    event IssuerAdded(address indexed issuer);
    event IssuerRemoved(address indexed issuer);
    event ConsumerRegistered(bytes32 indexed consumer, address wallet);
    event GeneratorRegistered(uint32 indexed generatorId, string name, address owner, address indexed issuer, uint16 commissionYear);
    event Issued(uint256 indexed id, address indexed to, uint256 kwh);
    event Transferred(uint256 indexed id, address indexed from, address indexed to, uint256 kwh);
    event ConsumptionRecorded(bytes32 indexed consumer, uint64 firstHour, uint256 hourCount, uint256 totalKwh);
    event Retired(uint256 indexed id, address indexed holder, bytes32 indexed consumer, uint64 hourIndex, uint256 kwh);
    event ClaimAnchored(bytes32 indexed claimHash, bytes32 indexed consumer, uint64 fromHour, uint64 toHour, uint16 claimedBps, uint16 matchedBps);

    error NotOperator();
    error NotIssuer();
    error NotGeneratorIssuer(uint32 generatorId);
    error UnknownGenerator();
    error GeneratorExists();
    error AlreadyIssued(uint256 id);
    error UnknownConsumer(bytes32 consumer);
    error ConsumerExists(bytes32 consumer);
    error NotConsumerWallet(bytes32 consumer);
    error OnlyOneTransfer(uint256 id);
    error ZeroAddress();
    error InsufficientBalance(uint256 id, uint256 have, uint256 want);
    error HourMismatch(uint64 certificateHour, uint64 consumptionHour);
    error ExceedsUnmatchedConsumption(uint64 hourIndex, uint256 unmatched, uint256 want);
    error BadRange();
    error AlreadyAnchored();
    error LengthMismatch();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer();
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    // ---------- governance

    function addIssuer(address issuer) external onlyOperator {
        if (issuer == address(0)) revert ZeroAddress();
        isIssuer[issuer] = true;
        emit IssuerAdded(issuer);
    }

    /// @notice A removed issuer cannot register plants or issue again. Certificates it issued earlier stay valid.
    function removeIssuer(address issuer) external onlyOperator {
        isIssuer[issuer] = false;
        emit IssuerRemoved(issuer);
    }

    function registerConsumer(bytes32 consumer, address wallet) external onlyOperator {
        if (wallet == address(0)) revert ZeroAddress();
        if (consumerWallet[consumer] != address(0)) revert ConsumerExists(consumer);
        consumerWallet[consumer] = wallet;
        emit ConsumerRegistered(consumer, wallet);
    }

    // ---------- ids

    function certificateId(uint32 generatorId, uint64 hourIndex) public pure returns (uint256) {
        return (uint256(generatorId) << 64) | uint256(hourIndex);
    }

    function hourOf(uint256 id) public pure returns (uint64) {
        return uint64(id & 0xFFFFFFFFFFFFFFFF);
    }

    function generatorOf(uint256 id) public pure returns (uint32) {
        return uint32(id >> 64);
    }

    // ---------- issuance

    function registerGenerator(uint32 generatorId, string calldata name, address owner, uint16 commissionYear)
        external
        onlyIssuer
    {
        if (generators[generatorId].exists) revert GeneratorExists();
        if (owner == address(0)) revert ZeroAddress();
        generators[generatorId] = Generator(name, owner, msg.sender, commissionYear, true);
        emit GeneratorRegistered(generatorId, name, owner, msg.sender, commissionYear);
    }

    /// @notice Issue certificates for consecutive hours from metered generation (one tx per plant per day).
    /// Only the issuer that registered the plant may issue for it, and each plant-hour can be issued once.
    /// Hours with zero output are skipped and leave no record.
    function issueBatch(uint32 generatorId, uint64 firstHour, uint256[] calldata kwh) external onlyIssuer {
        Generator storage g = generators[generatorId];
        if (!g.exists) revert UnknownGenerator();
        if (g.issuer != msg.sender) revert NotGeneratorIssuer(generatorId);
        for (uint256 i = 0; i < kwh.length; i++) {
            if (kwh[i] == 0) continue;
            uint256 id = certificateId(generatorId, firstHour + uint64(i));
            if (issued[id] != 0) revert AlreadyIssued(id);
            issued[id] = kwh[i];
            balanceOf[id][g.owner] += kwh[i];
            emit Issued(id, g.owner, kwh[i]);
        }
    }

    /// @notice Record metered consumption for consecutive hours (operator, standing in for the grid meter feed).
    /// A correction may never drop below what is already matched.
    function recordConsumption(bytes32 consumer, uint64 firstHour, uint256[] calldata kwh) external onlyOperator {
        if (consumerWallet[consumer] == address(0)) revert UnknownConsumer(consumer);
        uint256 total;
        for (uint256 i = 0; i < kwh.length; i++) {
            uint64 h = firstHour + uint64(i);
            if (kwh[i] < matched[consumer][h]) revert ExceedsUnmatchedConsumption(h, kwh[i], matched[consumer][h]);
            consumption[consumer][h] = kwh[i];
            total += kwh[i];
        }
        emit ConsumptionRecorded(consumer, firstHour, kwh.length, total);
    }

    // ---------- transfer (once) and retirement

    /// @notice Only the plant account can transfer, so every certificate changes hands at most once
    /// (plant to buyer). This follows the "transfer once in principle" rule of Taiwan's T-REC scheme.
    function transfer(uint256 id, address to, uint256 kwh) public {
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != generators[generatorOf(id)].owner) revert OnlyOneTransfer(id);
        uint256 have = balanceOf[id][msg.sender];
        if (have < kwh) revert InsufficientBalance(id, have, kwh);
        balanceOf[id][msg.sender] = have - kwh;
        balanceOf[id][to] += kwh;
        emit Transferred(id, msg.sender, to, kwh);
    }

    function transferBatch(uint256[] calldata ids, address to, uint256[] calldata kwh) external {
        if (ids.length != kwh.length) revert LengthMismatch();
        for (uint256 i = 0; i < ids.length; i++) {
            transfer(ids[i], to, kwh[i]);
        }
    }

    /// @notice Retire certificates against the same hour's metered consumption. Irreversible.
    /// Only the wallet bound to `consumer` can retire for it, and only certificates it holds.
    function retire(uint256 id, uint256 kwh, bytes32 consumer, uint64 consumptionHour) public {
        if (consumerWallet[consumer] != msg.sender) revert NotConsumerWallet(consumer);
        uint64 h = hourOf(id);
        if (h != consumptionHour) revert HourMismatch(h, consumptionHour);
        uint256 have = balanceOf[id][msg.sender];
        if (have < kwh) revert InsufficientBalance(id, have, kwh);
        uint256 unmatched = consumption[consumer][h] - matched[consumer][h];
        if (kwh > unmatched) revert ExceedsUnmatchedConsumption(h, unmatched, kwh);
        balanceOf[id][msg.sender] = have - kwh;
        retiredOf[id] += kwh;
        matched[consumer][h] += kwh;
        emit Retired(id, msg.sender, consumer, h, kwh);
    }

    function retireBatch(uint256[] calldata ids, uint256[] calldata kwh, bytes32 consumer) external {
        if (ids.length != kwh.length) revert LengthMismatch();
        for (uint256 i = 0; i < ids.length; i++) {
            retire(ids[i], kwh[i], consumer, hourOf(ids[i]));
        }
    }

    // ---------- public reads and claims

    /// @notice Share of a company's electricity matched hour by hour, in basis points (floor).
    function matchedBps(bytes32 consumer, uint64 fromHour, uint64 toHour)
        public
        view
        returns (uint16 bps, uint256 consumedKwh, uint256 matchedKwh)
    {
        if (toHour <= fromHour) revert BadRange();
        for (uint64 h = fromHour; h < toHour; h++) {
            consumedKwh += consumption[consumer][h];
            matchedKwh += matched[consumer][h];
        }
        bps = consumedKwh == 0 ? 0 : uint16((matchedKwh * 10000) / consumedKwh);
    }

    /// @notice A company anchors the hash of a claim it published about itself. The matched share stored
    /// in the event is computed here from chain state at that block, not supplied by the caller.
    /// Nobody, including the operator, can change or delete an anchored record afterwards.
    function anchorClaim(bytes32 claimHash, bytes32 consumer, uint64 fromHour, uint64 toHour, uint16 claimedBps)
        external
        returns (uint16 bps)
    {
        if (consumerWallet[consumer] != msg.sender) revert NotConsumerWallet(consumer);
        if (claimAnchoredAt[claimHash] != 0) revert AlreadyAnchored();
        (bps,,) = matchedBps(consumer, fromHour, toHour);
        claimAnchoredAt[claimHash] = block.timestamp;
        emit ClaimAnchored(claimHash, consumer, fromHour, toHour, claimedBps, bps);
    }
}
