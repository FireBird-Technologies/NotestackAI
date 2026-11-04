import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

type Job = { svg: string; w: number; h: number; done: (base64: string) => void; fail: (e: Error) => void };

/** The page that draws the SVG on a canvas and sends the PNG back, as the web's mapCanvas does. */
const page = ({ svg, w, h }: Job) => `<!doctype html><html><body><script>
(function () {
  var post = function (m) { window.ReactNativeWebView.postMessage(m); };
  var img = new Image();
  img.onload = function () {
    try {
      var c = document.createElement("canvas");
      c.width = ${w};
      c.height = ${h};
      c.getContext("2d").drawImage(img, 0, 0, ${w}, ${h});
      var d = c.toDataURL("image/png");
      post("ok:" + d.slice(d.indexOf(",") + 1));
    } catch (e) { post("err:" + e); }
  };
  img.onerror = function () { post("err:The picture could not be drawn."); };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(svg).replace(/</g, "\\u003c")});
})();
</script></body></html>`;

/**
 * Turns an SVG (a picture made here, like a Mind Constellation's) into a PNG, drawn by a hidden web view: the app has
 * no canvas of its own. Render `node` somewhere on the screen; `toPng` resolves with the PNG as base64.
 */
export function useSvgPng() {
  const [job, setJob] = useState<Job | null>(null);
  const current = useRef<Job | null>(null);
  const toPng = (svg: string, w: number, h: number) =>
    new Promise<string>((done, fail) => {
      const next = { svg, w, h, done, fail };
      current.current = next;
      setJob(next);
    });
  const node = job ? (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        source={{ html: page(job), baseUrl: "about:blank" }}
        originWhitelist={["*"]}
        onMessage={(e) => {
          const m = e.nativeEvent.data;
          const j = current.current;
          setJob(null);
          current.current = null;
          if (!j) return;
          if (m.startsWith("ok:")) j.done(m.slice(3));
          else j.fail(new Error(m.slice(4) || "The picture could not be made."));
        }}
      />
    </View>
  ) : null;
  return { node, toPng };
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" },
});
