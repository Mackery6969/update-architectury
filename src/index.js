import { log } from './log.js';
import { main } from './main.js';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    log.error(error.message);
    if (error.stack) log.debug(error.stack);
    process.exitCode = 1;
  },
);
