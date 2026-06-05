/**
 * @jest-environment node
 */

/**
 * Tests for snowflake-client.ts — regression tests for the Data Cache bug
 * and correct default configuration.
 */

import { executeQuery } from "../../src/server/snowflake-client";

// Mock fs module for getOAuthToken
jest.mock("fs", () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
}));

// We need to control process.env
const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    SNOWFLAKE_TOKEN: "test-token-123",
    // getAccountHost() now throws if neither SNOWFLAKE_HOST nor
    // SNOWFLAKE_ACCOUNT is set (fail-loud refactor — see snowflake-client.ts).
    // Provide a sentinel host so the executeQuery path can compose the URL.
    SNOWFLAKE_HOST: "test-account.snowflakecomputing.com",
  };
  jest.resetAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("snowflake-client executeQuery", () => {
  it("passes cache: 'no-store' to bypass Next.js Data Cache", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: "COL1", type: "fixed" }] },
        data: [["42"]],
      }),
    });
    global.fetch = mockFetch;

    await executeQuery("SELECT 1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.cache).toBe("no-store");
  });

  it("does NOT include role: in the request body (SPCS OAuth scoped-token regression test for gotcha #6)", async () => {
    // The OAuth token mounted at /snowflake/session/token inside SPCS is bound
    // to the app owner role and cannot switch roles. Sending `role: "..."` in
    // the body returns 390186 even when the underlying user has the role
    // granted. See README "Known gotchas" #6 + snowflake-client.ts:72.
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: "COL1", type: "fixed" }] },
        data: [["1"]],
      }),
    });
    global.fetch = mockFetch;

    await executeQuery("SELECT 1");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.role).toBeUndefined();
  });

  it("includes warehouse: CREDIT_DEMO_INT_WH in request body by default", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: "COL1", type: "fixed" }] },
        data: [["1"]],
      }),
    });
    global.fetch = mockFetch;

    await executeQuery("SELECT 1");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.warehouse).toBe("CREDIT_DEMO_INT_WH");
  });

  it("sends the SQL statement in the body", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: "CNT", type: "fixed" }] },
        data: [["100"]],
      }),
    });
    global.fetch = mockFetch;

    await executeQuery("SELECT COUNT(*) AS CNT FROM MY_TABLE");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.statement).toBe("SELECT COUNT(*) AS CNT FROM MY_TABLE");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "SQL compilation error",
    });
    global.fetch = mockFetch;

    await expect(executeQuery("INVALID SQL")).rejects.toThrow(
      /Snowflake API 422/
    );
  });

  it("parses numeric types correctly", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: {
          rowType: [
            { name: "INT_COL", type: "fixed" },
            { name: "FLOAT_COL", type: "real" },
            { name: "TEXT_COL", type: "text" },
          ],
        },
        data: [["42", "3.14", "hello"]],
      }),
    });
    global.fetch = mockFetch;

    const rows = await executeQuery("SELECT 1");
    expect(rows[0].INT_COL).toBe(42);
    expect(rows[0].FLOAT_COL).toBeCloseTo(3.14);
    expect(rows[0].TEXT_COL).toBe("hello");
  });

  // This test depends on Lane A's warehouse override feature.
  // If executeQuery doesn't accept opts yet, this will be skipped.
  it.skip("uses opts.warehouse override when provided (depends on Lane A)", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: "COL1", type: "fixed" }] },
        data: [["1"]],
      }),
    });
    global.fetch = mockFetch;

    // Lane A is adding: executeQuery(sql, { warehouse: "CUSTOM_WH" })
    // Once merged, unskip this test and update the call signature.
    await (executeQuery as Function)("SELECT 1", {
      warehouse: "CUSTOM_WH",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.warehouse).toBe("CUSTOM_WH");
  });
});
