import { launchpadApi } from "@notestack/shared/endpoints";
import type { CalendarItem, PostableArtifact, SocialAccounts } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";

import { Composer, PostEditor } from "@/launchpad/editors";
import { LibraryPicker } from "@/launchpad/library-picker";
import { ErrorText } from "@/ui";
import { BackLink } from "@/video/back";
import { Page, PageHead, Section, Sheet } from "@/widgets";

/** A new post: from a Library item (attached), or a copy of a scheduled post (its words and attachment). */
type Draft = { artifactId: string; text?: string };

/**
 * Schedule a launch (web: pages/Launchpad.tsx ScheduleLaunch, /app/launchpad/new): everything in the Library that can
 * go out, and the launch kits. An item opens the composer with it attached; a kit opens its page; an item already
 * scheduled opens that post.
 */
export default function ScheduleLaunch() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<CalendarItem | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts });
  const setAccounts = (a: SocialAccounts) => queryClient.setQueryData(["launchpad", "accounts"], a);
  const reload = () => {
    setRefreshKey((k) => k + 1);
    void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
  };

  /** The scheduled post `itemId` (of item `a`), looked up fresh; `then` opens it or a copy of it. */
  const withItem = async (a: PostableArtifact, itemId: string, then: (item: CalendarItem) => void) => {
    setOpening(a.id);
    setError("");
    try {
      const item = (await launchpadApi.items({ status: "scheduled" })).find((i) => i.id === itemId);
      if (item) then(item);
      else {
        setError("That post isn't scheduled anymore.");
        reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open that post. Try again.");
    } finally {
      setOpening(null);
    }
  };

  return (
    <Page>
      <BackLink fallback="/launchpad" />
      <PageHead eyebrow="Launchpad" title="Schedule a launch" />
      <ErrorText>{error}</ErrorText>
      <Section>
        <LibraryPicker
          onPick={(a) => setDraft({ artifactId: a.id })}
          onPickKit={(a) => router.push({ pathname: "/launchpad/kits/[id]", params: { id: a.id } })}
          onCreateKit={() => router.push("/launchpad/kits")}
          onReschedule={(a, itemId) => void withItem(a, itemId, setEditing)}
          onDuplicate={(a, itemId) => void withItem(a, itemId, (item) => setDraft({ artifactId: a.id, text: item.content }))}
          refreshKey={refreshKey}
          openingId={opening}
        />
      </Section>

      <Sheet visible={draft !== null} title="New post" onClose={() => setDraft(null)}>
        {draft ? (
          <Composer
            at={null}
            artifactId={draft.artifactId}
            initialText={draft.text}
            accounts={accounts.data ?? null}
            onAccounts={setAccounts}
            onCancel={() => setDraft(null)}
            onDone={() => {
              setDraft(null);
              void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
              // Scheduled: the calendar shows it (web: navigates to /app/launchpad).
              if (router.canGoBack()) router.back();
              else router.replace("/launchpad");
            }}
          />
        ) : null}
      </Sheet>
      <Sheet visible={editing !== null} title={editing ? `${editing.platform_label} post` : ""} onClose={() => setEditing(null)}>
        {editing ? <PostEditor item={editing} accounts={accounts.data ?? null} onAccounts={setAccounts} onChanged={reload} onClose={() => setEditing(null)} /> : null}
      </Sheet>
    </Page>
  );
}
