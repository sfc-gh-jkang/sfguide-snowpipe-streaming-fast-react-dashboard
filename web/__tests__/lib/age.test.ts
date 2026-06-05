import { formatAge } from "../../src/lib/age";

describe("formatAge", () => {
  it("formats 0 seconds", () => {
    expect(formatAge(0)).toBe("0s");
  });

  it("formats seconds below 60", () => {
    expect(formatAge(59)).toBe("59s");
  });

  it("formats exactly 60 seconds as 1m", () => {
    expect(formatAge(60)).toBe("1m");
  });

  it("formats 3599 seconds as 59m", () => {
    expect(formatAge(3599)).toBe("59m");
  });

  it("formats exactly 3600 seconds as 1h", () => {
    expect(formatAge(3600)).toBe("1h");
  });

  it("formats 86399 seconds as 23h", () => {
    expect(formatAge(86399)).toBe("23h");
  });

  it("formats exactly 86400 seconds as 1d", () => {
    expect(formatAge(86400)).toBe("1d");
  });

  it("formats fractional seconds by flooring", () => {
    expect(formatAge(59.9)).toBe("59s");
    expect(formatAge(0.1)).toBe("0s");
  });

  it("formats multi-day values", () => {
    expect(formatAge(172800)).toBe("2d");
  });
});
