import { PageHeader } from "../components/ui";
import VoiceProfile from "./VoiceProfile";

/** Manage voices (in the sidebar): the speaking voices for audio and video, and the writing voice. */
export default function Voices() {
  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Voices" title="Manage voices" />
      <VoiceProfile />
    </div>
  );
}
