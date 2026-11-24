const RealDate = Date

/**
 * Bun's test runner has no fake timers; this replaces the vitest pattern
 * vi.useFakeTimers({ toFake: ["Date"] }) + vi.setSystemTime(...). The returned
 * restore() puts the real Date back.
 */
export function fakeClock(at: string): () => void {
	const time = RealDate.parse(at)
	// biome-ignore lint/suspicious/noExplicitAny: test-only Date stand-in
	class FakeDate extends RealDate {
		constructor(...args: any[]) {
			super(...(args.length ? args : [time]))
		}
		static now(): number {
			return time
		}
	}
	;(globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor
	return () => {
		;(globalThis as { Date: DateConstructor }).Date = RealDate
	}
}
