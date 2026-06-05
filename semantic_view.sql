-- ==========================================================================
-- ACME Credit Management — Semantic View for Cortex Analyst
-- Target: ${APP_DB}.${APP_SCHEMA}.CREDIT_SV
-- ==========================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ${STANDARD_WH};

CREATE OR REPLACE SEMANTIC VIEW ${APP_DB}.${APP_SCHEMA}.CREDIT_SV
  TABLES (
    ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM
      PRIMARY KEY (POSITION_ID)
      COMMENT = 'Loan position dimension — 62 positions across 8 sectors and 4 funds. One row per position.',
    ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS
      COMMENT = 'Event stream — one row per trade, mark, or credit event. Filter EVENT_TYPE != WARMUP for analytics.'
  )
  RELATIONSHIPS (
    EVENTS_TO_POSITIONS AS RAW_EVENTS(POSITION_ID)
      REFERENCES POSITIONS_DIM(POSITION_ID)
  )
  DIMENSIONS (
    -- POSITIONS_DIM
    POSITIONS_DIM.POSITION_ID AS POSITION_ID
      COMMENT = 'Unique position identifier (POS-0001 through POS-0062).',
    POSITIONS_DIM.ISSUER AS ISSUER
      COMMENT = 'Company or borrower name (e.g. Apollo Health Holdings, Cascade Pipeline Co).'
      WITH CORTEX SEARCH SERVICE ${APP_DB}.${APP_SCHEMA}.POSITIONS_SEARCH,
    POSITIONS_DIM.SECTOR AS SECTOR
      COMMENT = 'Industry sector of the borrower.',
    POSITIONS_DIM.TRANCHE AS TRANCHE
      COMMENT = 'Loan tranche type (1L Term Loan, 2L Term Loan, Unitranche, Mezz, Equity Co-Invest).',
    POSITIONS_DIM.FUND AS FUND
      COMMENT = 'Fund vehicle holding the position.',
    POSITIONS_DIM.CURRENT_RATING AS CURRENT_RATING
      COMMENT = 'Latest credit rating of the issuer.',
    POSITIONS_DIM.WATCHLIST AS WATCHLIST
      COMMENT = 'TRUE if position is on the credit watchlist.',
    POSITIONS_DIM.PAR_AMOUNT AS PAR_AMOUNT
      COMMENT = 'Par (face) value of the loan position in USD.',
    POSITIONS_DIM.ORIGINAL_SPREAD_BPS AS ORIGINAL_SPREAD_BPS
      COMMENT = 'Original credit spread in basis points at origination.',
    POSITIONS_DIM.BASELINE_MARK AS BASELINE_MARK
      COMMENT = 'Opening mark for the position (price per 100 par).',
    -- RAW_EVENTS
    RAW_EVENTS.EVENT_TYPE AS EVENT_TYPE
      COMMENT = 'Type of event: TRADE, MARK, or CREDIT_EVENT. Exclude WARMUP for analytics.',
    RAW_EVENTS.SIDE AS SIDE
      COMMENT = 'Trade direction: BUY or SELL. Only populated for TRADE events.',
    RAW_EVENTS.COUNTERPARTY AS COUNTERPARTY
      COMMENT = 'Trading counterparty bank code (JPM, GS, MS, etc.). Only for TRADE events.',
    RAW_EVENTS.MARK_SOURCE AS MARK_SOURCE
      COMMENT = 'Source of the mark update. Only for MARK events.',
    RAW_EVENTS.FROM_RATING AS FROM_RATING
      COMMENT = 'Previous credit rating before the event. Only for CREDIT_EVENT.',
    RAW_EVENTS.TO_RATING AS TO_RATING
      COMMENT = 'New credit rating after the event. Only for CREDIT_EVENT.',
    RAW_EVENTS.AGENCY AS AGENCY
      COMMENT = 'Rating agency: SP, MOODY, or FITCH. Only for CREDIT_EVENT.',
    RAW_EVENTS.SOURCE_APP AS SOURCE_APP
      COMMENT = 'Application that generated the event.',
    RAW_EVENTS.EVENT_TS AS EVENT_TS
      COMMENT = 'Timestamp when the event occurred at the source.',
    RAW_EVENTS.INGESTED_TS AS INGESTED_TS
      COMMENT = 'Timestamp when the event was ingested into Snowflake via Snowpipe Streaming.',
    RAW_EVENTS.QTY AS QTY
      COMMENT = 'Trade quantity. Only populated for TRADE events.',
    RAW_EVENTS.PRICE AS PRICE
      COMMENT = 'Trade execution price. Only populated for TRADE events.',
    RAW_EVENTS.PREV_MARK AS PREV_MARK
      COMMENT = 'Previous mark-to-market value. Only for MARK events.',
    RAW_EVENTS.NEW_MARK AS NEW_MARK
      COMMENT = 'New mark-to-market value. Only for MARK events.'
  )
  COMMENT = 'Live credit book and event stream for ACME Credit Management. Fact table = RAW_EVENTS (one row per trade/mark/credit event). Dimension = POSITIONS_DIM (current loan positions). Use this view for any question about today P&L, sector exposure, watchlist, recent trades, mark moves, or credit downgrades.'
  WITH EXTENSION (CA='{"tables":[{"name":"POSITIONS_DIM","dimensions":[{"name":"SECTOR","sample_values":["Healthcare","Tech / SaaS","Energy / Util","Financial Svcs","Consumer","Business Svcs","Industrials","Real Estate"]},{"name":"TRANCHE","sample_values":["1L Term Loan","2L Term Loan","Unitranche","Mezz","Equity Co-Invest"]},{"name":"FUND","sample_values":["ACME Direct Lending II","ACME Opportunistic Credit","ACME Senior Secured III","ACME Special Sits"]},{"name":"CURRENT_RATING","sample_values":["B+","B","B-","BB-","CCC+","NR"]},{"name":"PAR_AMOUNT","sample_values":["42292121.76","59795876.00","34613565.95"]}]},{"name":"RAW_EVENTS","dimensions":[{"name":"EVENT_TYPE","sample_values":["TRADE","MARK","CREDIT_EVENT"]},{"name":"SIDE","sample_values":["BUY","SELL"]},{"name":"COUNTERPARTY","sample_values":["JPM","GS","MS","BAML","CITI","UBS","HSBC","DB","BNP","CS"]},{"name":"AGENCY","sample_values":["SP","MOODY","FITCH"]},{"name":"QTY","sample_values":["100000","500000","1000000"]},{"name":"PRICE","sample_values":["99.50","100.25","98.75"]},{"name":"NEW_MARK","sample_values":["99.87","100.50","97.25"]}],"time_dimensions":[{"name":"EVENT_TS","sample_values":["2026-05-13T09:00:00","2026-05-13T10:30:00"]},{"name":"INGESTED_TS","sample_values":["2026-05-13T09:00:01","2026-05-13T10:30:01"]}]}],"relationships":[{"name":"events_to_positions"}]}');
