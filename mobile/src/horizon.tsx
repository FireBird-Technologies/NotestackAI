import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { cubicBezier, useReducedMotion } from "react-native-reanimated";

import { colors } from "@/theme";

/** One pass of the flare along the planet's edge, as on the web hero (app.css, flare-ride and glint). */
const CYCLE = "18s";

/** The flare rides the arc: a rotation about the planet's centre, fading in on the left and out on the right. */
const flareRide = {
  "0%": { transform: [{ rotateZ: "-26deg" }], opacity: 0 },
  "15%": { opacity: 0.9 },
  "50%": { opacity: 1 },
  "85%": { opacity: 0.8 },
  "100%": { transform: [{ rotateZ: "26deg" }], opacity: 0 },
};

/** A sparkle that flashes and spins once per cycle. */
const glint = {
  "0%": { opacity: 0, transform: [{ scale: 0.2 }, { rotateZ: "0deg" }] },
  "4%": { opacity: 1, transform: [{ scale: 1.1 }, { rotateZ: "45deg" }] },
  "10%": { opacity: 0, transform: [{ scale: 0.4 }, { rotateZ: "90deg" }] },
  "100%": { opacity: 0, transform: [{ scale: 0.2 }, { rotateZ: "0deg" }] },
};

/** Where each sparkle sits across the planet (fraction of its width) and when it flashes. */
const GLINTS = [
  { at: 0.38, delay: "5.2s", lift: 10 },
  { at: 0.5, delay: "8.8s", lift: 12 },
  { at: 0.62, delay: "12.4s", lift: 10 },
] as const;

/** The glowing edge of a planet along the bottom of the screen, with a flare riding along it. */
export function Horizon({ rise }: { rise: number }) {
  const { width } = useWindowDimensions();
  const still = useReducedMotion();
  const size = width * 1.5;
  const planet = { width: size, height: size, borderRadius: size / 2, left: (width - size) / 2 };

  return (
    <View pointerEvents="none" style={[styles.wrap, { height: width * rise }]}>
      <View style={[styles.planet, planet]} />

      {/* A planet-sized frame turning about the planet's centre carries the flare along the arc. */}
      <Animated.View
        style={[
          styles.orbit,
          planet,
          still
            ? { opacity: 0.8 }
            : {
                animationName: flareRide,
                animationDuration: CYCLE,
                animationTimingFunction: cubicBezier(0.45, 0, 0.55, 1),
                animationIterationCount: "infinite",
              },
        ]}>
        <View style={styles.haze} />
        <View style={styles.flare} />
      </Animated.View>

      {!still &&
        GLINTS.map((g) => (
          <Animated.View
            key={g.delay}
            style={[
              styles.glint,
              { left: planet.left + size * g.at - 6, top: -g.lift },
              {
                animationName: glint,
                animationDuration: CYCLE,
                animationDelay: g.delay,
                animationTimingFunction: "ease-in-out",
                animationIterationCount: "infinite",
              },
            ]}>
            <View style={styles.glintH} />
            <View style={styles.glintV} />
          </Animated.View>
        ))}
    </View>
  );
}

const GLOW = { shadowColor: colors.blue, shadowOpacity: 1, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } } as const;

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "visible" },
  planet: {
    position: "absolute",
    top: 0,
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.blue,
    shadowColor: colors.blue,
    shadowOpacity: 0.9,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -4 },
    elevation: 24,
  },
  orbit: { position: "absolute", top: 0, opacity: 0 },
  // The flare is light, not an object: a white-hot centre that turns blue and fades out as it grows (the web's
  // .horizon-flare::after gradient), inside a wider, fainter blue haze (the streak's box-shadow on the web).
  flare: {
    position: "absolute",
    top: -32,
    left: "50%",
    marginLeft: -32,
    width: 64,
    height: 64,
    backgroundImage:
      "radial-gradient(circle, #ffffff 0%, rgba(255, 255, 255, 0.6) 10%, rgba(33, 124, 255, 0.6) 26%, rgba(33, 124, 255, 0) 64%)",
  },
  haze: {
    position: "absolute",
    top: -80,
    left: "50%",
    marginLeft: -80,
    width: 160,
    height: 160,
    backgroundImage: "radial-gradient(circle, rgba(33, 124, 255, 0.14) 0%, rgba(33, 124, 255, 0.05) 40%, rgba(33, 124, 255, 0) 70%)",
  },
  glint: {
    position: "absolute",
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
  },
  // The glow sits on the two solid strokes, not on their empty container, so iOS can draw it from their shape.
  glintH: { position: "absolute", width: 12, height: 1.5, borderRadius: 1, backgroundColor: colors.white, ...GLOW },
  glintV: { position: "absolute", width: 1.5, height: 12, borderRadius: 1, backgroundColor: colors.white, ...GLOW },
});
