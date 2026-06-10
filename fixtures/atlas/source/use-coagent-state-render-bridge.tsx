// Fixture mimicking packages/react-core/src/hooks/use-coagent-state-render-bridge.tsx
// (CopilotKit). It carries a "The Problem / The Solution" intentional-coupling
// design-block comment (lines ~24-45) and the code region it annotates. This is
// the §12.2 worked-row source: comment + code → ONE DERIVED fragment.
//
// This file is fixture data only; it is never imported as a module. The
// source-comment adapter is fed a structured SourceCommentUnit describing the
// commentText + codeRegion below, NOT this raw file.

import { useEffect, useRef } from "react";

/**
 * The Problem
 * -----------
 * Co-agent state-render output is asynchronous. By the time a state update
 * arrives, the conversation may have advanced to a later message. If we render
 * that update against whatever the "current" message happens to be, custom UI
 * detaches from the message that actually triggered it — the render lands on the
 * wrong message and the user sees stale or misplaced UI.
 *
 * The Solution
 * ------------
 * Bind each render to the messageId that triggered it, captured at the moment
 * the render request was issued. Re-renders then stay attached to the correct
 * message even as the conversation advances. This is an INTENTIONAL coupling
 * between a render and its originating messageId, not an incidental one — do not
 * "simplify" it away by rendering against the live/current message.
 */
export function useCoAgentStateRenderBridge(messageId: string) {
  const boundMessageId = useRef(messageId);

  useEffect(() => {
    // The render is bound to the messageId captured at request time, so async
    // state updates re-render against the originating message, never the
    // conversation's current head.
    boundMessageId.current = messageId;
  }, [messageId]);

  return boundMessageId.current;
}
