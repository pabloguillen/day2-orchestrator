import { startDay2 } from "./web";

/** For day2's scheduled simulation only: the library as a plain script that
 * a test browser injects into the app's pages before they load. */
(globalThis as unknown as { __day2: { startDay2: typeof startDay2 } }).__day2 = { startDay2 };
