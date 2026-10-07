import { z } from 'zod';

/*
 * Zod 4 probes `new Function('')` to JIT-compile object parsers. Under the app's CSP (no
 * 'unsafe-eval') that probe triggers a CSP violation, so JIT is disabled globally. This module must
 * be imported before any schema is constructed (it is the first import of every schema module).
 */
z.config({ jitless: true });
