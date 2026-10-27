import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const sharedGlobals = {
    ...globals.node,
    fetch: "readonly",
    FormData: "readonly",
    Blob: "readonly",
    AbortSignal: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
};

export default [
    {
        ignores: [
            "**/node_modules/**",
            "frontend/dist/**",
            "venv/**",
            ".venv/**",
            "**/__pycache__/**",
            "**/package-lock.json",
            ".git/**",
        ],
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: sharedGlobals,
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": [
                "warn",
                {
                    args: "none",
                    caughtErrors: "none",
                    ignoreRestSiblings: true,
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
    {
        files: ["frontend/src/**/*.{js,jsx}"],
        languageOptions: {
            globals: globals.browser,
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        plugins: {
            react,
            "react-hooks": reactHooks,
        },
        settings: {
            react: {
                version: "detect",
            },
        },
        rules: {
            ...react.configs.recommended.rules,
            "react/react-in-jsx-scope": "off",
            "react/jsx-uses-react": "off",
            "react/prop-types": "off",
            "react/jsx-uses-vars": "error",
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
        },
    },
    prettier,
];
