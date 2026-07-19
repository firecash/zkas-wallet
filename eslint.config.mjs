// One rule, on purpose: rules-of-hooks. A hook below an early return renders on
// some renders and not others, and React kills the whole tree with error #310
// the moment the counts differ — a crash the type checker and vitest both
// happily waved through (see the Balance "restoring" regression). This linter is
// the only tool that catches it before a user does.
import parser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/signer/firecash_signer.js"],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
