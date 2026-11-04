import { describe, expect, it } from "vitest";
import { ChartError, MAX_SERIES, MAX_SLICES, fullNumber, niceTicks, parseChart, shortNumber, toChart } from "@/lib/charts/spec";
import { checkEvent } from "@/lib/run/sandbox";

describe("chart blocks", () => {
  it("reads a bar chart", () => {
    const c = parseChart('{"type":"bar","title":"Spend","x":["Jan","Feb"],"series":[{"name":"Food","values":[1,2]}],"format":{"prefix":"£"}}');
    expect(c).toMatchObject({ type: "bar", title: "Spend", x: ["Jan", "Feb"], series: [{ name: "Food", values: [1, 2] }], prefix: "£" });
  });

  it("accepts the shapes models tend to write", () => {
    expect(toChart({ kind: "line", labels: ["a", "b"], data: [3, 4] }).series[0].values).toEqual([3, 4]);
    expect(toChart({ type: "column", series: [{ data: [{ label: "x", value: 5 }, { label: "y", value: "1,200" }] }] })).toMatchObject({
      type: "bar",
      x: ["x", "y"],
      series: [{ values: [5, 1200] }],
    });
    expect(toChart({ type: "doughnut", x: ["a"], values: ["40%"] }).series[0].values).toEqual([40]);
  });

  it("pads short series with gaps and adds missing labels", () => {
    const c = toChart({ type: "line", x: ["a"], series: [{ values: [1, 2, 3] }, { values: [1] }] });
    expect(c.x).toEqual(["a", "2", "3"]);
    expect(c.series[1].values).toEqual([1, null, null]);
  });

  it("reads scatter points", () => {
    const c = toChart({ type: "scatter", series: [{ name: "s", points: [[1, 2], { x: 3, y: 4 }, ["a", 1]] }] });
    expect(c.points[0].points).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("keeps pie charts to positive slices and folds the rest into Other", () => {
    const x = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const c = toChart({ type: "pie", x, series: [{ values: x.map((_, i) => (i === 0 ? -5 : i)) }] });
    expect(c.x).toHaveLength(MAX_SLICES);
    expect(c.x.at(-1)).toBe("Other");
    expect(c.series[0].values.every((v) => v !== null && v > 0)).toBe(true);
  });

  it("caps series and text, and strips control characters", () => {
    const c = toChart({ type: "bar", title: "a\u0000b".padEnd(500, "x"), series: Array.from({ length: 20 }, () => ({ values: [1] })) });
    expect(c.series).toHaveLength(MAX_SERIES);
    expect(c.title!.length).toBeLessThanOrEqual(120);
    expect(c.title).not.toContain("\u0000");
  });

  it("refuses what can't be drawn", () => {
    expect(() => parseChart("not json")).toThrow(ChartError);
    expect(() => parseChart('{"type":"radar","series":[{"values":[1]}]}')).toThrow(ChartError);
    expect(() => parseChart('{"type":"bar","series":[{"values":["x"]}]}')).toThrow(ChartError);
    expect(() => parseChart('{"type":"pie","x":["a"],"series":[{"values":[-1]}]}')).toThrow(ChartError);
    expect(() => parseChart("[1,2]")).toThrow(ChartError);
  });

  it("picks round axis steps", () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-3, 12, 5)).toEqual([-5, 0, 5, 10, 15]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });

  it("formats numbers", () => {
    expect(shortNumber(12500, { prefix: "£", suffix: "" })).toBe("£12.5K");
    expect(shortNumber(-20, { prefix: "£", suffix: "" })).toBe("-£20");
    expect(fullNumber(1234.5, { prefix: "", suffix: "%" })).toBe("1,234.5%");
    expect(fullNumber(null, { prefix: "", suffix: "" })).toBe("–");
  });
});

describe("results from the Python sandbox", () => {
  it("passes text, errors and charts through", () => {
    expect(checkEvent({ kind: "text", data: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(checkEvent({ kind: "chart", data: '{"type":"bar"}' })).toEqual({ kind: "chart", spec: { type: "bar" } });
    expect(checkEvent({ kind: "done" })).toBe("done");
  });

  it("only lets PNG pictures through", () => {
    expect(checkEvent({ kind: "image", data: "iVBORw0KGgo=" })).toEqual({ kind: "image", data: "iVBORw0KGgo=" });
    expect(checkEvent({ kind: "image", data: "PHN2Zz48L3N2Zz4=" })).toBeNull(); // an SVG
    expect(checkEvent({ kind: "image", data: 'iVBOR"><script>' })).toBeNull();
  });

  it("drops anything else", () => {
    expect(checkEvent({ kind: "html", data: "<b>" })).toBeNull();
    expect(checkEvent({ kind: "text", data: 5 })).toBeNull();
    expect(checkEvent({ kind: "chart", data: "{" })).toBeNull();
    expect(checkEvent(null)).toBeNull();
  });
});
