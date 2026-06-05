/**
 * Tests for LatencyTimeline chart data computation.
 * We test that the chart datasets correctly reflect the LatencyBar segment values.
 */

import React from "react";
import { render } from "@testing-library/react";

// Mock react-chartjs-2 to capture the data prop passed to <Bar>
let capturedData: unknown = null;
jest.mock("react-chartjs-2", () => ({
  Bar: (props: { data: unknown }) => {
    capturedData = props.data;
    return React.createElement("div", { "data-testid": "mock-bar-chart" });
  },
}));

// Mock chart.js to avoid registration errors in jsdom
jest.mock("chart.js", () => ({
  Chart: { register: jest.fn() },
  CategoryScale: "CategoryScale",
  LinearScale: "LinearScale",
  BarElement: "BarElement",
  Tooltip: "Tooltip",
  Legend: "Legend",
}));

// Mock the Zustand store
const mockLatencyBars = jest.fn();
jest.mock("@/lib/store", () => ({
  useDashboardStore: (selector: (s: { latencyBars: unknown[] }) => unknown) =>
    selector({ latencyBars: mockLatencyBars() }),
}));

import { LatencyTimeline } from "../../src/components/LatencyTimeline";

describe("LatencyTimeline", () => {
  beforeEach(() => {
    capturedData = null;
  });

  it("renders correct segment values for a sample LatencyBar", () => {
    const sampleBar = {
      label: "Click #1",
      network_ms: 1000,
      sdk_appended_ms: 30,
      flush_committed_ms: 250,
      it_poll_ms: 200,
      render_ms: 10,
    };
    mockLatencyBars.mockReturnValue([sampleBar]);

    render(React.createElement(LatencyTimeline));

    expect(capturedData).not.toBeNull();
    const data = capturedData as {
      labels: string[];
      datasets: Array<{ label: string; data: number[] }>;
    };

    // 5 datasets: Network, SDK append, HPA flush, IT poll, React render
    expect(data.datasets).toHaveLength(5);
    expect(data.labels).toEqual(["Click #1"]);

    // Each dataset has one data point matching the bar's segment
    expect(data.datasets[0].data[0]).toBe(1000); // network_ms
    expect(data.datasets[1].data[0]).toBe(30); // sdk_appended_ms
    expect(data.datasets[2].data[0]).toBe(250); // flush_committed_ms
    expect(data.datasets[3].data[0]).toBe(200); // it_poll_ms
    expect(data.datasets[4].data[0]).toBe(10); // render_ms
  });

  it("total equals sum of all segments", () => {
    const sampleBar = {
      label: "Click #2",
      network_ms: 50,
      sdk_appended_ms: 25,
      flush_committed_ms: 150,
      it_poll_ms: 300,
      render_ms: 8,
    };
    mockLatencyBars.mockReturnValue([sampleBar]);

    render(React.createElement(LatencyTimeline));

    const data = capturedData as {
      datasets: Array<{ data: number[] }>;
    };

    const total = data.datasets.reduce((sum, ds) => sum + ds.data[0], 0);
    const expected =
      sampleBar.network_ms +
      sampleBar.sdk_appended_ms +
      sampleBar.flush_committed_ms +
      sampleBar.it_poll_ms +
      sampleBar.render_ms;
    expect(total).toBe(expected);
  });

  it("Render dataset is always present even when render_ms is 0", () => {
    const sampleBar = {
      label: "Click #3",
      network_ms: 100,
      sdk_appended_ms: 20,
      flush_committed_ms: 200,
      it_poll_ms: 150,
      render_ms: 0,
    };
    mockLatencyBars.mockReturnValue([sampleBar]);

    render(React.createElement(LatencyTimeline));

    const data = capturedData as {
      datasets: Array<{ label: string; data: number[] }>;
    };

    // The "5 · React render" dataset must exist
    const renderDataset = data.datasets.find((ds) =>
      ds.label.toLowerCase().includes("render")
    );
    expect(renderDataset).toBeDefined();
    expect(renderDataset!.data[0]).toBe(0);
  });

  it("shows placeholder text when no bars exist", () => {
    mockLatencyBars.mockReturnValue([]);

    const { container } = render(React.createElement(LatencyTimeline));

    expect(container.textContent).toContain("Fire a few events");
    expect(capturedData).toBeNull(); // Bar chart not rendered
  });
});
