-- ==========================================================================
-- ACME Credit Management — Live Credit Desk Demo
-- Setup SQL (idempotent — safe to re-run)
-- Target: <your-snowflake-account> (<your-account-id>), ACCOUNTADMIN
-- ==========================================================================

USE ROLE ACCOUNTADMIN;

-- Bootstrap can take a few minutes (compute pool creation, semantic view
-- compile, etc.). Override any short default statement timeout for this
-- session so individual DDLs don't get cancelled mid-bootstrap.
ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 600;

-- -------------------------------------------------------------------------
-- 1. Database + Schema + Warehouses
-- -------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS ${APP_DB}
  COMMENT = 'Snowflake demo database (auto-provisioned by setup.sql)';

CREATE SCHEMA IF NOT EXISTS ${APP_DB}.${APP_SCHEMA}
  COMMENT = 'ACME Credit Mgmt live demo';

CREATE WAREHOUSE IF NOT EXISTS ${STANDARD_WH}
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 30
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'ACME demo standard WH';

ALTER WAREHOUSE ${STANDARD_WH} RESUME IF SUSPENDED;
USE WAREHOUSE ${STANDARD_WH};

-- -------------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------------
-- RAW_EVENTS is an INTERACTIVE TABLE: Snowpipe Streaming HPA writes rows
-- DIRECTLY into it via the channel API (auto-pipe RAW_EVENTS-STREAMING) — no
-- intermediate landing table, no COPY INTO. It is BOTH the system of record
-- AND the hot serving layer (same pattern as the Snowflake arcade-lab
-- ARCADE_SCORES table). CLUSTER BY (EVENT_TS) so the dashboard's "last 24h"
-- tile queries prune micro-partitions and stay sub-second on the Interactive
-- WH. Position attributes are DENORMALIZED onto every event (ISSUER ..
-- CURRENT_RATING) so serving queries never join POSITIONS_DIM — an Interactive
-- Warehouse can only join interactive tables, so the denormalized copy keeps
-- every tile query single-table.
--
-- CREATE OR REPLACE (not IF NOT EXISTS): a standard table cannot be altered
-- into an interactive one, so bootstrap recreates it. The producer re-seeds one
-- baseline event per position on startup (interactive tables reject INSERT DML,
-- so seeding happens via the streaming path, not SQL). Drop the auto-created
-- streaming pipe AND any pre-existing RAW_EVENTS first — you cannot CREATE OR
-- REPLACE across table types (standard -> interactive), so an explicit DROP is
-- required. The HPA SDK recreates RAW_EVENTS-STREAMING on the next channel open.
DROP PIPE IF EXISTS ${APP_DB}.${APP_SCHEMA}."RAW_EVENTS-STREAMING";
DROP TABLE IF EXISTS ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS;

CREATE INTERACTIVE TABLE ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS (
    EVENT_ID        VARCHAR     NOT NULL,
    EVENT_TS        TIMESTAMP_NTZ NOT NULL,
    INGESTED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    EVENT_TYPE      VARCHAR     NOT NULL,
    POSITION_ID     VARCHAR,
    SIDE            VARCHAR,
    QTY             NUMBER(18,2),
    PRICE           NUMBER(10,4),
    COUNTERPARTY    VARCHAR,
    PREV_MARK       NUMBER(10,4),
    NEW_MARK        NUMBER(10,4),
    MARK_SOURCE     VARCHAR,
    FROM_RATING     VARCHAR,
    TO_RATING       VARCHAR,
    AGENCY          VARCHAR,
    PAYLOAD         VARIANT,
    SOURCE_APP      VARCHAR DEFAULT 'streamlit_demo',
    -- Denormalized POSITIONS_DIM attributes (static per POSITION_ID; the
    -- producer stamps these onto every event from an in-memory dimension map).
    ISSUER          VARCHAR,
    SECTOR          VARCHAR,
    TRANCHE         VARCHAR,
    PAR_AMOUNT      NUMBER(18,2),
    FUND            VARCHAR,
    WATCHLIST       BOOLEAN,
    BASELINE_MARK   NUMBER(10,4),
    CURRENT_RATING  VARCHAR
)
CLUSTER BY (EVENT_TS);

-- POSITION_BOOK is a SECOND INTERACTIVE TABLE — the producer maintains a running
-- per-position book in memory and WRITE-THROUGHs the fully pre-computed book line
-- (CURRENT_MARK/PNL_TODAY/RATING already combined) into it on every event, via a
-- parallel HPA channel (auto-pipe POSITION_BOOK-STREAMING). This is the "replaces
-- Redis" pattern done the fresh way: the WRITER maintains the hot cache, so reads
-- are a cheap latest-per-position scan of pre-aggregated rows with ZERO refresh
-- lag — unlike a TARGET_LAG dynamic table, which would add ingestion→refresh
-- staleness. Serving strategy 2 reads this table; strategies 1 & 3 aggregate
-- RAW_EVENTS at query time. It is append-only (streaming), so reads still take the
-- latest row per position, but each row is pre-combined. CLUSTER BY (POSITION_ID)
-- so the latest-per-position window prunes tightly.
--
-- RETENTION / COMPACTION PLAN (append-only growth): one row accumulates per event
-- per position, so the table grows with event volume. The latest-per-position read
-- stays correct regardless, and CLUSTER BY (POSITION_ID) co-locates each position's
-- rows so the scan prunes — sufficient for a demo (62 positions, modest rate) for
-- days/weeks. For a long-running deployment, compact by recreating the table and
-- re-streaming the current 62-row book snapshot from the producer off-hours (you
-- cannot DELETE — interactive tables reject DML); or have the producer emit a
-- periodic per-position heartbeat so the read can safely filter to a recent window
-- without dropping quiet positions. Time Travel + storage lifecycle policies are
-- the longer-term Snowflake-managed path once available for interactive tables.
DROP PIPE IF EXISTS ${APP_DB}.${APP_SCHEMA}."POSITION_BOOK-STREAMING";
DROP TABLE IF EXISTS ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK;

CREATE INTERACTIVE TABLE ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK (
    POSITION_ID     VARCHAR     NOT NULL,
    BOOK_TS         TIMESTAMP_NTZ NOT NULL,
    LAST_EVENT_TYPE VARCHAR,
    ISSUER          VARCHAR,
    SECTOR          VARCHAR,
    TRANCHE         VARCHAR,
    PAR_AMOUNT      NUMBER(18,2),
    FUND            VARCHAR,
    WATCHLIST       BOOLEAN,
    CURRENT_MARK    NUMBER(10,4),
    OPENING_MARK    NUMBER(10,4),
    MARK_CHANGE_BPS NUMBER(18,4),
    PNL_TODAY       NUMBER(24,4),
    RATING          VARCHAR
)
CLUSTER BY (POSITION_ID);

CREATE TABLE IF NOT EXISTS ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM (
    POSITION_ID         VARCHAR     NOT NULL PRIMARY KEY,
    ISSUER              VARCHAR     NOT NULL,
    SECTOR              VARCHAR     NOT NULL,
    TRANCHE             VARCHAR     NOT NULL,
    PAR_AMOUNT          NUMBER(18,2) NOT NULL,
    ORIGINAL_SPREAD_BPS NUMBER(8,1)  NOT NULL,
    VINTAGE_YEAR        NUMBER(4,0)  NOT NULL,
    FUND                VARCHAR     NOT NULL,
    WATCHLIST           BOOLEAN     DEFAULT FALSE,
    CURRENT_RATING      VARCHAR,
    BASELINE_MARK       NUMBER(10,4) NOT NULL DEFAULT 100
);

-- App runtime config — Streamlit reads INGEST_URL/API_KEY from here at startup.
-- deploy.sh populates from .env (so secrets stay out of the app code/stage).
CREATE TABLE IF NOT EXISTS ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} (
    KEY     STRING NOT NULL PRIMARY KEY,
    VALUE   STRING NOT NULL,
    UPDATED TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- -------------------------------------------------------------------------
-- 3. Seed POSITIONS_DIM — 62 synthetic positions (ACME fund branding)
--    Uses MERGE so re-runs are idempotent.
-- -------------------------------------------------------------------------
MERGE INTO ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM AS tgt
USING (
  SELECT * FROM VALUES
    ('POS-0001','Apollo Health Holdings','Healthcare','2L Term Loan',42292121.76,770.5,2026,'ACME Special Sits',FALSE,'CCC+',99.8696),
    ('POS-0002','Vista Medical Partners','Healthcare','2L Term Loan',59795876.00,750.5,2022,'ACME Special Sits',TRUE,'NR',98.4611),
    ('POS-0003','Vista Medical Partners','Healthcare','1L Term Loan',34613565.95,519.5,2026,'ACME Direct Lending II',FALSE,'BB-',98.7298),
    ('POS-0004','Bayside Hospital Group','Healthcare','2L Term Loan',66723812.27,865.5,2024,'ACME Special Sits',FALSE,'B-',100.0639),
    ('POS-0005','MedTech Roll-Up Co','Healthcare','Unitranche',36504702.29,649.5,2026,'ACME Senior Secured III',FALSE,'CCC+',100.2049),
    ('POS-0006','CarePoint Specialty','Healthcare','2L Term Loan',9700201.24,775.8,2022,'ACME Special Sits',FALSE,'B-',100.0372),
    ('POS-0007','Bright Diagnostics LLC','Healthcare','1L Term Loan',54947390.43,584.9,2024,'ACME Special Sits',FALSE,'B',98.6926),
    ('POS-0008','Bright Diagnostics LLC','Healthcare','2L Term Loan',54787678.44,830.4,2022,'ACME Direct Lending II',FALSE,'CCC+',100.3427),
    ('POS-0009','Atlas Pharma Services','Healthcare','Unitranche',32115702.90,741.7,2025,'ACME Special Sits',FALSE,'BB-',99.8256),
    ('POS-0010','Atlas Pharma Services','Healthcare','1L Term Loan',69426383.62,469.7,2025,'ACME Opportunistic Credit',FALSE,'NR',98.4166),
    ('POS-0011','Northgate Software','Tech / SaaS','1L Term Loan',41394190.61,469.3,2022,'ACME Direct Lending II',TRUE,'CCC+',98.6864),
    ('POS-0012','Helix Cloud Holdings','Tech / SaaS','2L Term Loan',21319043.86,758.9,2024,'ACME Opportunistic Credit',TRUE,'NR',98.8323),
    ('POS-0013','Helix Cloud Holdings','Tech / SaaS','Mezz',71645682.65,997.2,2026,'ACME Opportunistic Credit',FALSE,'NR',98.5189),
    ('POS-0014','Stratus Data Co','Tech / SaaS','Mezz',70648746.14,1057.1,2023,'ACME Opportunistic Credit',FALSE,'BB-',98.0574),
    ('POS-0015','Beacon CyberSec','Tech / SaaS','Unitranche',51300253.87,669.0,2024,'ACME Special Sits',FALSE,'BB-',98.4903),
    ('POS-0016','Pinnacle DevTools','Tech / SaaS','2L Term Loan',19439151.33,791.4,2023,'ACME Direct Lending II',FALSE,'BB-',97.2820),
    ('POS-0017','Lumen Analytics LLC','Tech / SaaS','1L Term Loan',44499351.51,617.8,2022,'ACME Opportunistic Credit',FALSE,'B+',99.6416),
    ('POS-0018','Lumen Analytics LLC','Tech / SaaS','2L Term Loan',72091359.63,918.9,2025,'ACME Direct Lending II',FALSE,'B+',97.8763),
    ('POS-0019','Argon AI Labs','Tech / SaaS','2L Term Loan',60276619.48,843.5,2022,'ACME Senior Secured III',FALSE,'B+',97.4253),
    ('POS-0020','Ironbridge Mfg','Industrials','Unitranche',51260506.94,717.6,2022,'ACME Senior Secured III',FALSE,'B',98.7480),
    ('POS-0021','Ironbridge Mfg','Industrials','2L Term Loan',44071375.55,893.2,2023,'ACME Senior Secured III',FALSE,'NR',98.7229),
    ('POS-0022','Cascade Industrial','Industrials','1L Term Loan',71976670.13,484.3,2023,'ACME Direct Lending II',FALSE,'B',98.8524),
    ('POS-0023','Northwind Components','Industrials','Unitranche',18813188.97,776.2,2024,'ACME Special Sits',FALSE,'BB-',96.8858),
    ('POS-0024','Cardinal Forge Co','Industrials','1L Term Loan',53950376.46,565.3,2026,'ACME Direct Lending II',FALSE,'B',98.9311),
    ('POS-0025','Summit Aerospace Sub','Industrials','1L Term Loan',53286591.16,473.9,2024,'ACME Special Sits',FALSE,'B',96.7305),
    ('POS-0026','Granite Logistics','Industrials','Unitranche',26855872.65,779.0,2024,'ACME Special Sits',FALSE,'BB-',98.6686),
    ('POS-0027','Granite Logistics','Industrials','1L Term Loan',45577810.26,594.3,2023,'ACME Senior Secured III',FALSE,'NR',97.7090),
    ('POS-0028','Bedrock Materials','Industrials','1L Term Loan',35824972.68,525.4,2023,'ACME Direct Lending II',FALSE,'CCC+',99.2350),
    ('POS-0029','Lakeshore Brands','Consumer','1L Term Loan',17894786.21,454.7,2024,'ACME Opportunistic Credit',FALSE,'CCC+',96.8578),
    ('POS-0030','Foothill Apparel','Consumer','1L Term Loan',66030464.50,614.8,2024,'ACME Direct Lending II',FALSE,'BB-',99.0114),
    ('POS-0031','Crestwood Foods','Consumer','1L Term Loan',22863191.09,551.7,2024,'ACME Opportunistic Credit',FALSE,'B',97.8748),
    ('POS-0032','Highline Pet Co','Consumer','1L Term Loan',50679763.62,559.8,2023,'ACME Opportunistic Credit',FALSE,'B+',98.4394),
    ('POS-0033','Brightwater Beverages','Consumer','1L Term Loan',72018399.03,554.6,2024,'ACME Senior Secured III',FALSE,'B',97.0518),
    ('POS-0034','Madison Home Goods','Consumer','Equity Co-Invest',9229613.85,0.0,2025,'ACME Special Sits',FALSE,'NR',114.1326),
    ('POS-0035','Madison Home Goods','Consumer','Unitranche',52338571.18,647.3,2026,'ACME Senior Secured III',FALSE,'NR',98.8709),
    ('POS-0036','Riverside Restaurants','Consumer','1L Term Loan',27625175.46,558.2,2022,'ACME Special Sits',FALSE,'B',99.7485),
    ('POS-0037','Riverside Restaurants','Consumer','Unitranche',73594535.59,594.9,2026,'ACME Opportunistic Credit',FALSE,'BB-',98.5600),
    ('POS-0038','Sentinel Specialty Finance','Financial Svcs','2L Term Loan',8133510.99,823.6,2026,'ACME Opportunistic Credit',FALSE,'B',98.4383),
    ('POS-0039','Sentinel Specialty Finance','Financial Svcs','Unitranche',56683818.82,636.9,2025,'ACME Direct Lending II',FALSE,'B+',99.8146),
    ('POS-0040','Highmark Insurance Sub','Financial Svcs','2L Term Loan',47216116.42,905.8,2024,'ACME Senior Secured III',FALSE,'B+',97.1734),
    ('POS-0041','Keystone Wealth Holdings','Financial Svcs','2L Term Loan',29620472.73,881.4,2023,'ACME Special Sits',FALSE,'NR',100.1790),
    ('POS-0042','Beacon Title Co','Financial Svcs','1L Term Loan',63718619.79,568.0,2023,'ACME Special Sits',FALSE,'BB-',97.7801),
    ('POS-0043','Beacon Title Co','Financial Svcs','Unitranche',37778093.12,793.1,2026,'ACME Direct Lending II',FALSE,'CCC+',98.3323),
    ('POS-0044','Cascade Mortgage Svcs','Financial Svcs','1L Term Loan',56002973.21,584.8,2026,'ACME Opportunistic Credit',FALSE,'NR',97.8218),
    ('POS-0045','Pinewood Staffing','Business Svcs','Mezz',8704532.88,1066.9,2025,'ACME Special Sits',FALSE,'B-',97.8550),
    ('POS-0046','Pinewood Staffing','Business Svcs','1L Term Loan',22731364.27,474.2,2023,'ACME Special Sits',FALSE,'CCC+',99.0207),
    ('POS-0047','Apex Facility Svcs','Business Svcs','Mezz',44110401.91,1065.5,2025,'ACME Opportunistic Credit',FALSE,'B+',99.3221),
    ('POS-0048','Crossroads Marketing','Business Svcs','1L Term Loan',42960654.52,567.8,2022,'ACME Opportunistic Credit',FALSE,'CCC+',100.4540),
    ('POS-0049','Granite Compliance','Business Svcs','Unitranche',52078297.83,613.8,2024,'ACME Senior Secured III',TRUE,'B-',97.0329),
    ('POS-0050','Granite Compliance','Business Svcs','2L Term Loan',32534558.00,843.2,2025,'ACME Senior Secured III',FALSE,'BB-',99.7598),
    ('POS-0051','Northbay Consulting','Business Svcs','Mezz',51245529.94,1250.3,2026,'ACME Direct Lending II',FALSE,'CCC+',98.8833),
    ('POS-0052','Northbay Consulting','Business Svcs','2L Term Loan',52257393.67,765.6,2024,'ACME Special Sits',FALSE,'CCC+',100.4182),
    ('POS-0053','Southridge Midstream','Energy / Util','1L Term Loan',36742201.40,621.1,2025,'ACME Opportunistic Credit',FALSE,'B',97.9550),
    ('POS-0054','Bluewater Renewables','Energy / Util','2L Term Loan',56652153.01,871.4,2023,'ACME Opportunistic Credit',FALSE,'NR',98.7918),
    ('POS-0055','Cascade Pipeline Co','Energy / Util','Unitranche',26784601.50,790.8,2024,'ACME Opportunistic Credit',FALSE,'B+',99.2719),
    ('POS-0056','Cascade Pipeline Co','Energy / Util','Mezz',53555064.58,1269.3,2024,'ACME Opportunistic Credit',FALSE,'CCC+',96.8680),
    ('POS-0057','Highline Power Holdings','Energy / Util','1L Term Loan',68308798.27,479.1,2024,'ACME Senior Secured III',FALSE,'BB-',97.1552),
    ('POS-0058','Westport Property Hldg','Real Estate','Unitranche',36330290.76,606.2,2025,'ACME Opportunistic Credit',FALSE,'CCC+',100.4675),
    ('POS-0059','Beacon Self-Storage','Real Estate','1L Term Loan',65363240.83,591.0,2026,'ACME Special Sits',TRUE,'B+',99.4562),
    ('POS-0060','Lakeline Hospitality','Real Estate','1L Term Loan',55892032.15,574.4,2023,'ACME Special Sits',TRUE,'B+',99.0928),
    ('POS-0061','Northgate Residential','Real Estate','Mezz',27236814.20,1132.4,2024,'ACME Special Sits',FALSE,'BB-',99.6733),
    ('POS-0062','Northgate Residential','Real Estate','2L Term Loan',72967981.38,871.7,2026,'ACME Senior Secured III',FALSE,'NR',96.8153)
  AS src (POSITION_ID,ISSUER,SECTOR,TRANCHE,PAR_AMOUNT,ORIGINAL_SPREAD_BPS,VINTAGE_YEAR,FUND,WATCHLIST,CURRENT_RATING,BASELINE_MARK)
) AS src
ON tgt.POSITION_ID = src.POSITION_ID
WHEN NOT MATCHED THEN INSERT
  (POSITION_ID,ISSUER,SECTOR,TRANCHE,PAR_AMOUNT,ORIGINAL_SPREAD_BPS,VINTAGE_YEAR,FUND,WATCHLIST,CURRENT_RATING,BASELINE_MARK)
  VALUES
  (src.POSITION_ID,src.ISSUER,src.SECTOR,src.TRANCHE,src.PAR_AMOUNT,src.ORIGINAL_SPREAD_BPS,src.VINTAGE_YEAR,src.FUND,src.WATCHLIST,src.CURRENT_RATING,src.BASELINE_MARK);

-- -------------------------------------------------------------------------
-- 4. Interactive Warehouse
--    Serves ALL dashboard reads (tape + tiles + time-travel) directly from the
--    RAW_EVENTS interactive table. There is no separate rollup table or view:
--    the position-book tiles aggregate at query time. With 62 positions and a
--    table clustered on EVENT_TS, the "last 24h" window queries prune to a small
--    scan and stay sub-second, well under the 5s interactive-warehouse timeout.
--    The /api/snapshot/standard route runs the SAME queries on ${STANDARD_WH}
--    for the A/B latency comparison — a standard WH can also read an interactive
--    table, just without the pre-computed index + warm SSD cache.
-- -------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS ${INTERACTIVE_WH}
  WAREHOUSE_TYPE = 'INTERACTIVE'
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 86400
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'ACME demo Interactive WH';

-- Associate the streaming targets so the Interactive WH can serve them. Both
-- RAW_EVENTS (strategies 1 & 3, query-time rollup) and POSITION_BOOK (strategy 2,
-- pre-agg write-through) are interactive tables served by this same WH.
ALTER WAREHOUSE ${INTERACTIVE_WH} ADD TABLES (
  ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS,
  ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK
);

-- CREATE WAREHOUSE above set the INTERACTIVE WH as the session's current
-- warehouse. Switch back to the standard WH so the rest of this script (network
-- rules, Cortex Search build) does NOT run on the interactive WH — which has a
-- 5s query timeout and cannot query non-interactive tables like POSITIONS_DIM.
USE WAREHOUSE ${STANDARD_WH};

-- -------------------------------------------------------------------------
-- 6. Ingest role + user placeholder
--    The service user requires an RSA keypair — generate manually:
--      openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out credit_ingest.p8 -nocrypt
--      openssl rsa -in credit_ingest.p8 -pubout -out credit_ingest.pub
--    Then uncomment the CREATE USER below with the public key pasted in.
-- -------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS ${INGEST_ROLE}
  COMMENT = 'ACME demo Snowpipe Streaming ingest role';

GRANT USAGE ON DATABASE ${APP_DB} TO ROLE ${INGEST_ROLE};
GRANT USAGE ON SCHEMA ${APP_DB}.${APP_SCHEMA} TO ROLE ${INGEST_ROLE};
GRANT USAGE ON WAREHOUSE ${STANDARD_WH} TO ROLE ${INGEST_ROLE};
-- HPA SDK auto-creates a PIPE named <TABLE>-STREAMING on first channel open.
-- Without CREATE PIPE the SDK fails with HTTP 404 on /v2/streaming/hostname.
GRANT CREATE PIPE ON SCHEMA ${APP_DB}.${APP_SCHEMA} TO ROLE ${INGEST_ROLE};
GRANT INSERT ON TABLE ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS TO ROLE ${INGEST_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS TO ROLE ${INGEST_ROLE};
-- POSITION_BOOK write-through target (strategy 2) — producer streams pre-agg rows.
GRANT INSERT ON TABLE ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK TO ROLE ${INGEST_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK TO ROLE ${INGEST_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM TO ROLE ${INGEST_ROLE};

-- CREATE USER IF NOT EXISTS CREDIT_INGEST_USR
--   TYPE = SERVICE
--   RSA_PUBLIC_KEY = '<paste-public-key-here>'
--   COMMENT = 'Snowpipe Streaming producer service account';
-- GRANT ROLE ${INGEST_ROLE} TO USER CREDIT_INGEST_USR;

-- -------------------------------------------------------------------------
-- 7. Stage for SiS deployment
-- -------------------------------------------------------------------------
CREATE STAGE IF NOT EXISTS ${APP_DB}.${APP_SCHEMA}.${INGEST_STAGE}
  COMMENT = 'ACME SiS app stage';

-- -------------------------------------------------------------------------
-- 8. Compute Pool for SiS Container Runtime
-- -------------------------------------------------------------------------
CREATE COMPUTE POOL IF NOT EXISTS CREDIT_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_SUSPEND_SECS = 600
  AUTO_RESUME = TRUE
  COMMENT = 'ACME Credit demo SiS Container Runtime pool';

-- -------------------------------------------------------------------------
-- 9. Network Rule + External Access Integration (tunnel egress)
--
--    The VALUE_LIST below is a STUB that gets rewritten on every `./deploy.sh`
--    run from the INGEST_TUNNEL_HOST in your `.env` (see deploy.sh — it does
--    `CREATE OR REPLACE NETWORK RULE` immediately before the Streamlit deploy).
--    You do NOT need to envsubst this file or replace the placeholder by hand.
-- -------------------------------------------------------------------------
CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.CREDIT_INGEST_RULE
  MODE = EGRESS
  TYPE = HOST_PORT
  -- Resolvable stub host. Some accounts validate that egress hosts resolve in
  -- DNS at CREATE time, so we can't use a placeholder/unresolved host here. This
  -- legacy rule is unused by the React dashboard; the real tunnel host is set on
  -- the dashboard rule below by deploy-app.sh.
  VALUE_LIST = ('example.com:443')
  COMMENT = 'Legacy SiS rule — resolvable stub host';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION CREDIT_INGEST_EAI
  ALLOWED_NETWORK_RULES = (${APP_DB}.${APP_SCHEMA}.CREDIT_INGEST_RULE)
  ENABLED = TRUE;

-- PYPI_ACCESS is an account-level pre-existing EAI on some legacy SE demo
-- accounts. It's only used by the parent SiS Streamlit fork; the React
-- dashboard doesn't need it. If it doesn't exist on your account, this
-- statement will error harmlessly — comment out if it bothers you.
-- GRANT USAGE ON INTEGRATION PYPI_ACCESS TO ROLE ACCOUNTADMIN;

-- -------------------------------------------------------------------------
-- 10. Cortex Search Service (fuzzy issuer lookup for the Agent)
-- -------------------------------------------------------------------------
-- Cortex Search initial-build can take 30-60s. Set a generous statement
-- timeout on the warehouse before this DDL so it doesn't get cancelled
-- mid-build by a snow-CLI default timeout.
ALTER WAREHOUSE ${STANDARD_WH} SET STATEMENT_TIMEOUT_IN_SECONDS = 600;
ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 600;

-- IF NOT EXISTS (not OR REPLACE) — re-bootstrap on an account where the
-- service already exists would hit a 5s rebuild timeout. To force a rebuild,
-- DROP the service manually first.
CREATE CORTEX SEARCH SERVICE IF NOT EXISTS ${APP_DB}.${APP_SCHEMA}.POSITIONS_SEARCH
  ON ISSUER
  ATTRIBUTES POSITION_ID, SECTOR, TRANCHE, FUND, CURRENT_RATING
  WAREHOUSE = ${STANDARD_WH}
  TARGET_LAG = '1 minute'
  AS (
    SELECT position_id, issuer, sector, tranche, par_amount, fund, current_rating, watchlist
    FROM ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM
  );

-- -------------------------------------------------------------------------
-- 11. Cortex Agent (text-to-SQL + fuzzy search)
--     Requires: semantic_view.sql to have been run first (CREDIT_SV).
--     Run this section AFTER semantic_view.sql, or accept the error and re-run.
-- -------------------------------------------------------------------------
-- IMPORTANT: use FROM SPECIFICATION $$...$$  (NOT  SPEC = '{...}').
-- The SPEC= form silently stores an EMPTY spec; FROM SPECIFICATION actually persists it.
-- Also: orchestration text containing "P&L" tickles snow CLI's & template parser, so
-- always run this file with templating disabled (snow sql --enable-templating false ...)
-- or run this CREATE AGENT block via the Snowflake driver/Snowsight directly.
CREATE OR REPLACE AGENT ${APP_DB}.${APP_SCHEMA}.${AGENT_NAME}
  WITH PROFILE = '{ "display_name": "Credit Desk Agent" }'
  COMMENT = 'Credit desk analyst — text-to-SQL + fuzzy issuer search'
  FROM SPECIFICATION $$
{
  "models": {"orchestration": "auto"},
  "instructions": {
    "response": "You are a credit-desk analyst assistant for ACME Credit Management. Answer concisely with numbers and tables. When showing P&L, sector exposure, or watchlist data, prefer markdown tables. For event-stream questions (recent trades, marks, downgrades), include event_ts. Always filter out EVENT_TYPE = 'WARMUP' rows unless specifically asked about warmup events.",
    "orchestration": "Use credit_book_analyst for ANY quantitative question (recent trades, P&L, sector breakdowns, top N, watchlist, marks, downgrades, counts, sums). Use issuer_search when the user mentions a specific issuer by partial or fuzzy name. Combine when needed: search to find the issuer name first, then analyst to compute its metrics. Never claim you have no data — always call credit_book_analyst first."
  },
  "tools": [
    {"tool_spec": {"type": "cortex_analyst_text_to_sql", "name": "credit_book_analyst", "description": "Query RAW_EVENTS (event stream with trades, marks, credit events) and POSITIONS_DIM (62 loan positions with issuer, sector, fund, par amount) for any quantitative question about the credit book."}},
    {"tool_spec": {"type": "cortex_search", "name": "issuer_search", "description": "Find loan positions by fuzzy issuer name match. Returns position_id, sector, tranche, fund, current_rating metadata. Use when a user mentions a company name that might be partial or misspelled."}}
  ],
  "tool_resources": {
    "credit_book_analyst": {
      "execution_environment": {"type": "warehouse", "warehouse": "${STANDARD_WH}"},
      "semantic_view": "${APP_DB}.${APP_SCHEMA}.CREDIT_SV"
    },
    "issuer_search": {
      "id_column": "POSITION_ID",
      "title_column": "ISSUER",
      "max_results": 10,
      "search_service": "${APP_DB}.${APP_SCHEMA}.POSITIONS_SEARCH"
    }
  }
}
$$;

-- ==========================================================================
-- DASHBOARD APP (Next.js fork) — additive objects
-- These coexist with the parent fork's CREDIT_* objects above.
-- The Next.js React dashboard replaces Streamlit for sub-100ms render loops.
-- ==========================================================================

-- -------------------------------------------------------------------------
-- 12. Compute Pool for Next.js SPCS App
-- -------------------------------------------------------------------------
CREATE COMPUTE POOL IF NOT EXISTS ${DASHBOARD_POOL}
  MIN_NODES = 1
  MAX_NODES = 2
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_SUSPEND_SECS = 600
  AUTO_RESUME = TRUE
  COMMENT = 'Next.js dashboard SPCS pool (coexists with CREDIT_POOL for SiS)';

-- -------------------------------------------------------------------------
-- 13. Network Rule + External Access Integration (dashboard → VM tunnel)
--     Mirrors CREDIT_INGEST_EAI structure; allows the SPCS Next.js app to
--     proxy POST /ingest to the VM cloudflared tunnel on :443.
--     deploy-app.sh rewrites the VALUE_LIST from INGEST_TUNNEL_HOST in .env.
-- -------------------------------------------------------------------------
CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.${INGEST_NETWORK_RULE}
  MODE = EGRESS
  TYPE = HOST_PORT
  -- Resolvable stub — deploy-app.sh CREATE OR REPLACEs this with the real
  -- INGEST_TUNNEL_HOST once the tunnel is up (a not-yet-live host fails on
  -- accounts that DNS-validate egress rules at CREATE time).
  VALUE_LIST = ('example.com:443')
  COMMENT = 'Dashboard egress to VM ingest tunnel — stub host, rewritten by deploy-app.sh';

-- Permissive build-time rule + EAI. snow app deploy uses build_eai during the
-- npm install phase to fetch packages from registry.npmjs.org and friends.
-- Listing every npm CDN explicitly is brittle, so we open all hosts on :443
-- — this rule is ONLY bound to the build job, not the running app, so the
-- runtime container is still gated to the narrow ${INGEST_NETWORK_RULE}.
CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.DASHBOARD_BUILD_RULE
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('0.0.0.0:443', '0.0.0.0:80')
  COMMENT = 'Permissive build-time rule for npm install during snow app deploy';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ${DASHBOARD_EAI}
  ALLOWED_NETWORK_RULES = (
    ${APP_DB}.${APP_SCHEMA}.${INGEST_NETWORK_RULE},
    ${APP_DB}.${APP_SCHEMA}.DASHBOARD_BUILD_RULE
  )
  ENABLED = TRUE;

-- -------------------------------------------------------------------------
-- 13b. Self-healing tunnel registration (zero-setup, no named tunnel needed)
-- The ingest producer polls cloudflared's /quicktunnel metrics endpoint and
-- CALLs this proc whenever the quick-tunnel hostname rotates, so APP_CONFIG +
-- the egress network rule stay current with NO operator action (the dashboard
-- re-reads APP_CONFIG every ~60s and self-heals). EXECUTE AS OWNER lets the
-- narrow ${INGEST_ROLE} (keypair) call it WITHOUT holding ALTER/CREATE on the
-- config objects — it can only invoke this one proc.
-- -------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ${APP_DB}.${APP_SCHEMA}.SP_SET_INGEST_HOST(HOST STRING)
  RETURNS STRING
  LANGUAGE SQL
  EXECUTE AS OWNER
AS
$$
BEGIN
  MERGE INTO ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} AS tgt
  USING (SELECT 'INGEST_TUNNEL_HOST' AS KEY, :HOST AS VALUE) AS src
  ON tgt.KEY = src.KEY
  WHEN MATCHED THEN UPDATE SET VALUE = src.VALUE, UPDATED = CURRENT_TIMESTAMP()
  WHEN NOT MATCHED THEN INSERT (KEY, VALUE) VALUES (src.KEY, src.VALUE);

  EXECUTE IMMEDIATE
    'CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.${INGEST_NETWORK_RULE} '
    || 'MODE = EGRESS TYPE = HOST_PORT VALUE_LIST = (''' || :HOST || ':443'')';

  RETURN 'INGEST_TUNNEL_HOST=' || :HOST;
END;
$$;

GRANT USAGE ON PROCEDURE ${APP_DB}.${APP_SCHEMA}.SP_SET_INGEST_HOST(STRING) TO ROLE ${INGEST_ROLE};

-- -------------------------------------------------------------------------
-- 14. Dashboard role (read-only on demo tables + agent + search)
-- -------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS ${DASHBOARD_ROLE}
  COMMENT = 'Next.js dashboard app role — read-only on credit demo objects';

GRANT USAGE ON DATABASE ${APP_DB} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON SCHEMA ${APP_DB}.${APP_SCHEMA} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON WAREHOUSE ${INTERACTIVE_WH} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON WAREHOUSE ${STANDARD_WH} TO ROLE ${DASHBOARD_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.RAW_EVENTS TO ROLE ${DASHBOARD_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.POSITION_BOOK TO ROLE ${DASHBOARD_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.POSITIONS_DIM TO ROLE ${DASHBOARD_ROLE};
GRANT SELECT ON TABLE ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON AGENT ${APP_DB}.${APP_SCHEMA}.${AGENT_NAME} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON CORTEX SEARCH SERVICE ${APP_DB}.${APP_SCHEMA}.POSITIONS_SEARCH TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON COMPUTE POOL ${DASHBOARD_POOL} TO ROLE ${DASHBOARD_ROLE};
GRANT USAGE ON INTEGRATION ${DASHBOARD_EAI} TO ROLE ${DASHBOARD_ROLE};

-- The SPCS Snowflake App service runs as the deploying user, using a
-- per-service OAuth token mounted at /snowflake/session/token. The Next.js
-- code sends `role: ${DASHBOARD_ROLE}` in every Snowflake REST call so it
-- can scope reads to the read-only role rather than full ACCOUNTADMIN.
-- For that role-switch to be permitted, the deploying user must have the
-- role granted. Without this, every snapshot/agent/ingest call returns
-- 390186 "Role not granted to this user".
USE WAREHOUSE ${STANDARD_WH};
EXECUTE IMMEDIATE $$
BEGIN
  LET cur_user STRING := CURRENT_USER();
  EXECUTE IMMEDIATE 'GRANT ROLE ${DASHBOARD_ROLE} TO USER "' || :cur_user || '"';
  EXECUTE IMMEDIATE 'GRANT ROLE ${INGEST_ROLE} TO USER "' || :cur_user || '"';
  RETURN 'Granted ${DASHBOARD_ROLE} + ${INGEST_ROLE} to ' || :cur_user;
END;
$$;
