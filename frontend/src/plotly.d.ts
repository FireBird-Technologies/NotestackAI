declare module "plotly.js-basic-dist-min" {
  type Element = HTMLElement;
  const Plotly: {
    newPlot: (element: Element, data: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<void>;
    purge: (element: Element) => void;
    Plots: { resize: (element: Element) => void };
  };
  export default Plotly;
}
