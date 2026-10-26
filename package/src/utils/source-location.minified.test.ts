import { execFileSync } from "node:child_process";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SourceLocationResult } from "./source-location";

const fixtureSource = `
import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { getSourceLocation } from "./source-location";

function useFixtureState() { return React.useState(0); }
function DirectComponent() {
  const [count, setCount] = React.useState(0);
  return React.createElement("button", { onClick: () => setCount(count + 1) }, "Count " + count);
}
function CustomHookComponent() {
  const [count, setCount] = useFixtureState();
  return React.createElement("button", { onClick: () => setCount(count + 1) }, "Count " + count);
}
export function mount(container, customHook, anonymous) {
  const Component = customHook ? CustomHookComponent : DirectComponent;
  if (anonymous) Object.defineProperty(Component, "name", { value: "" });
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(Component)));
  return () => flushSync(() => root.unmount());
}
export function click(button) { flushSync(() => button.click()); }
export { getSourceLocation };
`;

interface ProbeFixture {
  mount(container: HTMLElement, customHook: boolean, anonymous: boolean): () => void;
  click(button: HTMLButtonElement): void;
  getSourceLocation(element: HTMLElement): SourceLocationResult;
}

let bundle: string;
let sourceMap: SourceMap;
let unmount: (() => void) | undefined;
let container: HTMLDivElement;

beforeAll(() => {
  const options = {
    stdin: {
      contents: fixtureSource,
      sourcefile: "source-probe-fixture.tsx",
      resolveDir: resolve("src/utils"),
      loader: "tsx",
    },
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "probeFixture",
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: "external",
    outfile: "fixture.js",
    write: false,
  };
  // esbuild needs Node's typed-array globals rather than jsdom's globals.
  const output = JSON.parse(execFileSync(process.execPath, ["-e", `
    const { buildSync } = require("esbuild");
    const { readFileSync } = require("node:fs");
    const { outputFiles } = buildSync(JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write(JSON.stringify(outputFiles.map(file => ({ path: file.path, text: file.text }))));
  `], {
    input: JSON.stringify(options),
    encoding: "utf8",
  })) as { path: string; text: string }[];
  bundle = output.find((file) => file.path.endsWith(".js"))!.text;
  sourceMap = new SourceMap(JSON.parse(output.find((file) => file.path.endsWith(".js.map"))!.text));
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  container?.remove();
});

function mountFixture(
  path: string,
  { customHook = true, anonymous = false, stackSetup = "" } = {}
) {
  const context = createContext({ window, document, navigator, console, setTimeout, clearTimeout });
  runInContext(stackSetup, context);
  const fixture = runInContext(`${bundle}\nprobeFixture;`, context, {
    filename: `http://localhost${path}`,
  }) as ProbeFixture;
  container = document.createElement("div");
  document.body.appendChild(container);
  unmount = fixture.mount(container, customHook, anonymous);
  const button = container.querySelector("button")!;
  return { fixture, button };
}

function expectComponentSource(result: SourceLocationResult, hookCall: string) {
  expect(result.found).toBe(true);
  const source = result.source!;
  const mapped = sourceMap.findEntry(source.lineNumber - 1, source.columnNumber! - 1);
  if (!("originalSource" in mapped)) {
    throw new Error("No source-map entry for the captured frame");
  }
  expect(mapped.originalSource).toMatch(/source-probe-fixture\.tsx$/);
  expect(mapped.originalLine).toBe(
    fixtureSource.split("\n").findIndex((line) => line.includes(hookCall))
  );
}

describe("source probing in a shared minified bundle", () => {
  it.each([
    [false, "const [count, setCount] = React.useState(0);"],
    [true, "const [count, setCount] = useFixtureState();"],
  ])("locates the component with customHook=%s", (customHook, hookCall) => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js", { customHook });
    expectComponentSource(fixture.getSourceLocation(button), hookCall);
  });

  it.each([
    "/_next/static/chunks/app_checkout_abc.js",
    "/assets/main-Ka8h-Yin.js",
  ])("uses the function boundary for components inside %s", (path) => {
    const { fixture, button } = mountFixture(path);
    expectComponentSource(fixture.getSourceLocation(button), "const [count, setCount] = useFixtureState();");
  });

  it("does not require the component's function name", () => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js", { anonymous: true });
    expectComponentSource(fixture.getSourceLocation(button), "const [count, setCount] = useFixtureState();");
  });

  it("restores the React dispatcher after probing", () => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js");
    expectComponentSource(fixture.getSourceLocation(button), "const [count, setCount] = useFixtureState();");
    fixture.click(button);
    expect(button.textContent).toBe("Count 1");
  });

  it("omits ambiguous source when captureStackTrace and the function name are unavailable", () => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js", {
      anonymous: true,
      stackSetup: "Error.captureStackTrace = undefined;",
    });
    expect(fixture.getSourceLocation(button)).toMatchObject({ found: false, reason: "no-debug-source" });
  });

  it("keeps the named-component fallback without captureStackTrace", () => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js", {
      stackSetup: "Error.captureStackTrace = undefined;",
    });
    expectComponentSource(fixture.getSourceLocation(button), "const [count, setCount] = useFixtureState();");
  });

  it("omits source when the probe stack is truncated before the component", () => {
    const { fixture, button } = mountFixture("/static/js/async/123456.abcdef123456.js", {
      stackSetup: "Error.stackTraceLimit = 1;",
    });
    expect(fixture.getSourceLocation(button)).toMatchObject({ found: false, reason: "no-debug-source" });
  });
});
