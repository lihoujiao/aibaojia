import { migrate } from "./db";
import { seed } from "./seed";

let started: Promise<void> | null = null;

export function resetReady(): void {
  started = null;
}

export function ready(): Promise<void> {
  if (!started) {
    started = (async () => {
      await migrate();
      await seed();
    })();
  }
  return started;
}
