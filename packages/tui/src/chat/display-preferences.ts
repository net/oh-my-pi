/** Process-wide display preferences applied by the host settings hooks. */
export interface ChatTranscriptDisplayPreferences {
	hideToolActivity: boolean;
	/** While tool activity is hidden, one summary line per run of tool calls. */
	toolActivitySummary: boolean;
	readToolResultPreview: boolean;
	/** Blank rows above and below user message bubbles. */
	userMessagePadding: boolean;
	showImages: boolean;
	cacheMissMarker: boolean;
	showTokenUsage: boolean;
	showTurnTime: boolean;
}

/** Current transcript display preferences. */
export const chatTranscriptDisplayPreferences: ChatTranscriptDisplayPreferences = {
	hideToolActivity: false,
	toolActivitySummary: false,
	readToolResultPreview: false,
	userMessagePadding: true,
	showImages: true,
	cacheMissMarker: false,
	showTokenUsage: false,
	showTurnTime: false,
};

/** Apply host display preferences without pulling settings into the renderer. */
export function setChatTranscriptDisplayPreferences(preferences: Partial<ChatTranscriptDisplayPreferences>): void {
	Object.assign(chatTranscriptDisplayPreferences, preferences);
}
