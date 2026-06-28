export interface MarketSnapshot {
  symbol: string;
  timestamp: string;
  price: number;
  volume_24h: number;
  open_interest: number;
  funding_rate: number;
  bid_ask_spread: number;
  orderbook_depth: number;
  trades_24h: number;
  volatility: number;            // ATR-based
}

export interface AlphaSignal {
  signal_id: string;
  correlation_id: string;
  symbol: string;
  strategy_type: string;
  direction: 'LONG' | 'SHORT';
  timestamp: string;
  alpha_score: number;           // 0–100
  confidence_score: number;      // 0–100
  expected_ev: number;
  market_regime: string;
  source_modules: string[];
  metadata: Record<string, any>;
  // Added for multi-account
  account_id?: string;
  environment?: 'LIVE' | 'BACKTEST';
}

export interface ConfidenceReport {
  signal_id: string;
  overall_confidence: number;     // 0–100
  data_quality: number;
  sample_quality: number;
  regime_certainty: number;
  feature_stability: number;
  component_scores: Record<string, number>;
}

export interface RiskAssessment {
  signal_id: string;
  overall_risk: number;           // 0–100 (lower = safer)
  account_risk: number;
  position_risk: number;
  sector_risk: number;
  correlation_risk: number;
  liquidity_risk: number;
  black_swan_active: boolean;
  risk_verdict: 'APPROVED' | 'REJECTED' | 'REDUCED';
  // Added for multi-account
  account_id: string;
  environment: 'LIVE' | 'BACKTEST';
}

export interface ConsensusDecision {
  signal_id: string;
  correlation_id: string;
  final_alpha: number;            // 0–100
  direction: 'LONG' | 'SHORT';
  confidence_score: number;       // from ConfidenceReport
  regime_alignment: number;
  decision_latency_ms: number;
  ttl_seconds: number;
  // Added for multi-account
  account_id: string;
  environment: 'LIVE' | 'BACKTEST';
  platform_name?: string;
}

export interface PortfolioState {
  account_id: string;
  environment: 'LIVE' | 'BACKTEST';
  platform_name: string;
  total_exposure: number;
  open_positions: number;
  sector_exposure: Record<string, number>;
  long_exposure: number;
  short_exposure: number;
  net_exposure: number;
  gross_exposure: number;
  available_balance: number;
  updated_at: string;
}

export interface AllocationDecision {
  signal_id: string;
  correlation_id: string;
  allocation_pct: number;         // % of total capital
  allocation_usdt: number;
  leverage: number;
  margin_type: 'ISOLATED' | 'CROSS';
  status: 'APPROVED' | 'REJECTED' | 'REDUCED';
  reason?: string;
  // Added for multi-account
  account_id: string;
  environment: 'LIVE' | 'BACKTEST';
  platform_name: string;
}

export type CapitalPreservationMode = 'NORMAL' | 'CAUTIOUS' | 'DEFENSIVE' | 'SURVIVAL' | 'LOCKDOWN';

export interface EventEnvelope {
  event_id: string;              // uuid
  event_type: string;            // "AlphaSignal", "TradeDecision", etc.
  producer: string;              // "HC-Opportunity-Analyzer"
  timestamp: string;             // ISO 8601 UTC
  schema_version: string;        // semantic version
  correlation_id: string;        // links all events for one trade candidate
  payload: any;                  // the actual data
  signature?: string;            // optional message integrity
}
