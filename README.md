# HC-Capital-Allocator

Layer 3 Module — Risk-Adjusted Position Sizing for HypeCatcher v3.

## Responsibility
HC-Capital-Allocator is the third pillar of the **Decision Trinity**. It takes an approved `ConsensusDecision` and calculates the appropriate position size in USDT based on:
1.  **Bayesian Consensus Score** (0-100)
2.  **Signal Confidence** (0-100)
3.  **Capital Preservation Mode** (CPM)
4.  **Portfolio State** (Available Balance & Exposure)

## Features
- **Sizing Matrix**: Implements institutional allocation ranges (0.25% to 3.00%).
- **Hard Caps**: Strictly enforces a 3% max position size per total AUM.
- **CPM Integration**: Scales down position sizes in `CAUTIOUS` mode (50%) and rejects trades in `DEFENSIVE`, `SURVIVAL`, or `LOCKDOWN` modes.
- **Multi-Account Support**: Correctly scopes allocations to specific `account_id` and `environment` (LIVE/BACKTEST).

## Technical Stack
- **Runtime**: Node.js (TypeScript)
- **Event Bus**: Redis Streams
- **Data Contracts**: Standardized via `HC-Shared-Commons`

## Setup
```bash
npm install
npm run build
npm run start
```

## Matrix Logic
| Score Range | Confidence Required | Allocation (% of capital) |
|-------------|-------------------|--------------------------|
| 50–60       | >80               | 0.25%                    |
| 60–70       | >80               | 0.50%                    |
| 70–80       | >85               | 1.00%                    |
| 80–90       | >90               | 2.00%                    |
| 90+         | >95               | 3.00%                    |
