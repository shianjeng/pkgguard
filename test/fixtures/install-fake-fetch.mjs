// Preloaded with `node --import` so the hook can be run end to end offline.
import { fakeFetch, NOW } from './fake-registry.mjs';

globalThis.fetch = fakeFetch();
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return NOW;
  }
};
