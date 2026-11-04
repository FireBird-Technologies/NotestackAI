import { citedLines } from "@notestack/shared/citations";
import type { Artifact, FlashcardData } from "@notestack/shared/types";
import { type ReactNode, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";

import { FeedbackRow, StudyModal } from "@/artifacts/study-modal";
import { colors, fonts, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

const shuffled = <T,>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Where a deck is: its order, the card shown and which side. Kept outside the popup, so minimising keeps the place. */
export function useDeck(count: number) {
  const [order, setOrder] = useState(() => Array.from({ length: count }, (_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [seen, setSeen] = useState(count);
  if (seen !== count) {
    setSeen(count);
    setOrder(Array.from({ length: count }, (_, i) => i));
    setPos(0);
    setFlipped(false);
  }
  const go = (d: number) => {
    setFlipped(false);
    setPos((p) => Math.min(Math.max(p + d, 0), order.length - 1));
  };
  const shuffle = () => {
    setOrder(shuffled(order));
    setPos(0);
    setFlipped(false);
  };
  return { order, pos, flipped, setFlipped, go, shuffle };
}

type Deck = ReturnType<typeof useDeck>;

/**
 * A deck you flip through (web: FlashcardDeck): tap the card to flip it, swipe or use the buttons to move. Skip and
 * Shuffle together, then Previous and Next. Used in its popup and inside a report.
 */
export function FlashcardDeck({ cards, deck: given, fill = false }: {
  cards: FlashcardData[];
  deck?: Deck;
  /** In its own popup: the card takes all the height there is, its words in the middle. */
  fill?: boolean;
}) {
  const own = useDeck(cards.length);
  const { order, pos, flipped, setFlipped, go, shuffle } = given ?? own;
  const turn = useSharedValue(0);
  const touchX = useRef(0);
  const spin = useAnimatedStyle(() => ({ transform: [{ perspective: 900 }, { rotateY: `${turn.value}deg` }] }));
  const card = cards[order[pos]];
  if (!card) return <Text style={styles.muted}>No cards.</Text>;

  // A quick turn: the card turns edge on, its other side is shown, and it turns back.
  const flip = () => {
    turn.value = withSequence(withTiming(90, { duration: 120 }), withTiming(0, { duration: 120 }));
    setTimeout(() => setFlipped((f) => !f), 120);
  };

  return (
    <View style={[styles.deck, fill && styles.grow]}>
      <Text style={styles.count}>
        Card {pos + 1} of {order.length}
      </Text>
      <View
        style={fill && styles.grow}
        onTouchStart={(e) => {
          touchX.current = e.nativeEvent.pageX;
        }}
        onTouchEnd={(e) => {
          const dx = e.nativeEvent.pageX - touchX.current;
          if (dx < -50) go(1);
          else if (dx > 50) go(-1);
        }}>
        <Animated.View style={[spin, fill && styles.grow]}>
          <Pressable
            onPress={flip}
            accessibilityRole="button"
            accessibilityLabel={flipped ? "Show the front" : "Show the answer"}
            style={({ pressed }) => [styles.card, fill && styles.grow, flipped && styles.flipped, pressed && styles.pressed]}>
            <Text style={styles.side}>{flipped ? "ANSWER" : "CARD"}</Text>
            <Text style={styles.text}>{flipped ? card.back : card.front}</Text>
            {flipped && card.sources?.length > 0 ? (
              <Text style={styles.src}>{card.sources.slice(0, 2).map((s) => `${s.title}, ${citedLines(s)}`).join(" · ")}</Text>
            ) : null}
            {!flipped ? <Text style={styles.hint}>Tap to flip</Text> : null}
          </Pressable>
        </Animated.View>
      </View>
      <View style={styles.actions}>
        <View style={styles.group}>
          <PillButton small title="Skip" onPress={() => go(1)} disabled={pos === order.length - 1} />
          <PillButton small title="Shuffle" onPress={shuffle} />
        </View>
        <View style={styles.group}>
          <PillButton small title="Previous" onPress={() => go(-1)} disabled={pos === 0} />
          <PillButton small title="Next" variant="primary" onPress={() => go(1)} disabled={pos === order.length - 1} />
        </View>
      </View>
    </View>
  );
}

/** A flashcard set in its popup (web: FlashcardsPlayer): the deck, then "How are these cards?" with the thumbs. */
export function FlashcardsScreen({ artifact, visible, onClose, feedback }: { artifact: Artifact; visible: boolean; onClose: () => void; feedback?: ReactNode }) {
  const cards = (artifact.content?.cards ?? []) as FlashcardData[];
  const deck = useDeck(cards.length);
  return (
    <StudyModal title={artifact.title} visible={visible} onClose={onClose} fill>
      <FlashcardDeck cards={cards} deck={deck} fill />
      {feedback ? <FeedbackRow label="How are these cards?">{feedback}</FeedbackRow> : null}
    </StudyModal>
  );
}

const styles = StyleSheet.create({
  deck: { gap: 14 },
  grow: { flexGrow: 1 },
  count: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  card: {
    minHeight: 320,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  flipped: { borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: colors.blue10 },
  pressed: { opacity: 0.85 },
  side: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 2.2 },
  text: { color: colors.white, fontFamily: fonts.displayMedium, fontSize: 20, lineHeight: 30, textAlign: "center" },
  src: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, textAlign: "center" },
  hint: { color: colors.text3, fontSize: 13 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 24, rowGap: 8 },
  group: { flexDirection: "row", gap: 8 },
  muted: { color: colors.text2 },
});
