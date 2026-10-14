// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HourlyCertificateRegistry
/// @notice Renewable energy certificates issued per generator per hour (1 unit = 1 kWh).
/// A certificate can only be retired once, only by its holder, and only against
/// metered consumption in the SAME hour. Anyone can recompute how much of a
/// consumer's electricity was matched hour by hour, straight from chain state.
/// @dev Certificate id = generatorId << 64 | hourIndex, where hourIndex = unix seconds / 3600.
contract HourlyCertificateRegistry {
    struct Generator {
        string name;
        address owner;
        uint16 commissionYear;
        bool exists;
    }

    address public immutable issuer; // certificate body / meter operator

    mapping(uint32 => Generator) public generators;
    mapping(uint256 => mapping(address => uint256)) public balanceOf; // id => holder => kWh
    mapping(uint256 => uint256) public issued; // id => kWh
    mapping(uint256 => uint256) public retiredOf; // id => kWh

    // consumer => hourIndex => kWh
    mapping(bytes32 => mapping(uint64 => uint256)) public consumption;
    mapping(bytes32 => mapping(uint64 => uint256)) public matched;

    // claim hash => block timestamp when anchored (0 = never)
    mapping(bytes32 => uint256) public claimAnchoredAt;

    event GeneratorRegistered(uint32 indexed generatorId, string name, address owner, uint16 commissionYear);
    event Issued(uint256 indexed id, address indexed to, uint256 kwh);
    event Transferred(uint256 indexed id, address indexed from, address indexed to, uint256 kwh);
    event ConsumptionRecorded(bytes32 indexed consumer, uint64 firstHour, uint256 hourCount, uint256 totalKwh);
    event Retired(uint256 indexed id, address indexed holder, bytes32 indexed consumer, uint64 hourIndex, uint256 kwh);
    event ClaimAnchored(bytes32 indexed claimHash, bytes32 indexed consumer, uint64 fromHour, uint64 toHour, uint16 claimedBps, uint16 matchedBps);

    error NotIssuer();
    error UnknownGenerator();
    error GeneratorExists();
    error InsufficientBalance(uint256 id, uint256 have, uint256 want);
    error HourMismatch(uint64 certificateHour, uint64 consumptionHour);
    error ExceedsUnmatchedConsumption(uint64 hourIndex, uint256 unmatched, uint256 want);
    error BadRange();
    error AlreadyAnchored();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor() {
        issuer = msg.sender;
    }

    function certificateId(uint32 generatorId, uint64 hourIndex) public pure returns (uint256) {
        return (uint256(generatorId) << 64) | uint256(hourIndex);
    }

    function hourOf(uint256 id) public pure returns (uint64) {
        return uint64(id & 0xFFFFFFFFFFFFFFFF);
    }

    function generatorOf(uint256 id) public pure returns (uint32) {
        return uint32(id >> 64);
    }

    function registerGenerator(uint32 generatorId, string calldata name, address owner, uint16 commissionYear)
        external
        onlyIssuer
    {
        if (generators[generatorId].exists) revert GeneratorExists();
        generators[generatorId] = Generator(name, owner, commissionYear, true);
        emit GeneratorRegistered(generatorId, name, owner, commissionYear);
    }

    /// @notice Issue certificates for consecutive hours from metered generation (one tx per day).
    function issueBatch(uint32 generatorId, uint64 firstHour, uint256[] calldata kwh) external onlyIssuer {
        Generator storage g = generators[generatorId];
        if (!g.exists) revert UnknownGenerator();
        for (uint256 i = 0; i < kwh.length; i++) {
            if (kwh[i] == 0) continue;
            uint256 id = certificateId(generatorId, firstHour + uint64(i));
            issued[id] += kwh[i];
            balanceOf[id][g.owner] += kwh[i];
            emit Issued(id, g.owner, kwh[i]);
        }
    }

    /// @notice Record metered consumption for consecutive hours (meter operator).
    function recordConsumption(bytes32 consumer, uint64 firstHour, uint256[] calldata kwh) external onlyIssuer {
        uint256 total;
        for (uint256 i = 0; i < kwh.length; i++) {
            uint64 h = firstHour + uint64(i);
            // a correction may never drop below what is already matched
            if (kwh[i] < matched[consumer][h]) revert ExceedsUnmatchedConsumption(h, kwh[i], matched[consumer][h]);
            consumption[consumer][h] = kwh[i];
            total += kwh[i];
        }
        emit ConsumptionRecorded(consumer, firstHour, kwh.length, total);
    }

    function transfer(uint256 id, address to, uint256 kwh) public {
        uint256 have = balanceOf[id][msg.sender];
        if (have < kwh) revert InsufficientBalance(id, have, kwh);
        balanceOf[id][msg.sender] = have - kwh;
        balanceOf[id][to] += kwh;
        emit Transferred(id, msg.sender, to, kwh);
    }

    function transferBatch(uint256[] calldata ids, address to, uint256[] calldata kwh) external {
        for (uint256 i = 0; i < ids.length; i++) {
            transfer(ids[i], to, kwh[i]);
        }
    }

    /// @notice Retire certificates against the same hour's metered consumption. Irreversible.
    function retire(uint256 id, uint256 kwh, bytes32 consumer, uint64 consumptionHour) public {
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
        for (uint256 i = 0; i < ids.length; i++) {
            retire(ids[i], kwh[i], consumer, hourOf(ids[i]));
        }
    }

    /// @notice Share of a consumer's electricity matched hour by hour, in basis points (floor).
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

    /// @notice Anchor a published claim so it cannot be quietly edited later. The matched
    /// share stored with it is recomputed here from chain state, not supplied by the caller.
    function anchorClaim(bytes32 claimHash, bytes32 consumer, uint64 fromHour, uint64 toHour, uint16 claimedBps)
        external
        returns (uint16 bps)
    {
        if (claimAnchoredAt[claimHash] != 0) revert AlreadyAnchored();
        (bps,,) = matchedBps(consumer, fromHour, toHour);
        claimAnchoredAt[claimHash] = block.timestamp;
        emit ClaimAnchored(claimHash, consumer, fromHour, toHour, claimedBps, bps);
    }
}
