/** Goal separation regressions use the selected clean upstream-derived runtime. */
import base from './upgrade.config.mjs';
export default { ...base, test: { ...base.test,
  include: ['dsh-goal-acceptance/tests/*.spec.ts'],
} };
