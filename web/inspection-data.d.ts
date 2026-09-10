export interface Artifact { path: string; source?: string; bytes?: number }
export interface Source { key: string; label: string; artifact?: Artifact; value?: unknown; problem?: string; plainText?: boolean }
export interface Call { key: string; id: string; label: string; status: string; recordIds?: string[]; artifact?: Artifact; inline?: Record<string, unknown>; model?: string; backend?: string; phase?: string; parentCallId?: string; usage?: Record<string, unknown>; [key: string]: unknown }
export interface Inspection { inputs: Source[]; outputs: Source[]; inputOrigin: string; calls: Call[]; warnings: string[]; artifacts: Artifact[] }
export function resolveArtifact(reference: unknown, artifacts: Artifact[], origin?: string): Artifact | null
export function readArtifactText(runId: string, artifact: Artifact, options?: { fetcher?: typeof fetch; signal?: AbortSignal; maxBytes?: number }): Promise<string>
export interface SavedStep { stepId?: string; output?: unknown; evidence?: { output?: string }; inputsFrom?: string[]; artifacts?: Artifact[]; branches?: SavedStep[]; [key: string]: unknown }
export interface SavedRun { steps?: SavedStep[]; params?: Record<string, unknown>; [key: string]: unknown }
export interface CallDetails extends Call { input?: unknown; prompt?: string; output?: unknown; warnings?: string[]; error?: string; settings?: unknown; transport?: unknown }
export function loadInspection(run: SavedRun, step: SavedStep, read: (artifact: Artifact) => Promise<string>): Promise<Inspection>
export function loadCall(call: Call, artifacts: Artifact[], read: (artifact: Artifact) => Promise<string>): Promise<CallDetails>
export function filterCalls(calls: Call[], query?: string, status?: string): Call[]
export function readableError(error: unknown): string
export function parsePreview(text: string, path?: string): { kind: string; value?: unknown; text: string; problem?: string; framed?: boolean }
