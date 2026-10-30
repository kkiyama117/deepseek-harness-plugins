/** Goal separation regressions use the selected clean upstream-derived runtime. */
import base from './upgrade.config.mjs';
export default { ...base, test: { ...base.test,
  include: ['plugins/dsh-goal-acceptance/tests/*.spec.ts'],
} };
