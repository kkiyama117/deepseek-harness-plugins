# Workflow result selection

This independent tool package retains the deployed `resultKeys` extension without patching DSH. It uses the official workflow engine and preserves native/background recording and cancellation. The complete JSON result is saved before selected fields are delivered; invalid keys or storage failure fail delivery.

Install this package, then replace the `tool-workflow` plugin in the selected preset with `@kkiyama117/dsh-workflow-results`; preserve its config and its isolated workflow engine. The package alone installs no Host tool. Source and upstream revision are recorded in `UPSTREAM.json`. `lib` is generated from `src` using the selected DSH checkout’s TypeScript compiler. The copied DSH code is MIT licensed; see LICENSE.
