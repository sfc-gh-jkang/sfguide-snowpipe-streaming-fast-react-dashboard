/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/?(*.)+(test|spec).[jt]s?(x)"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.(css|less|scss|sass)$": "<rootDir>/__tests__/__mocks__/styleMock.js",
  },
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: {
          jsx: "react-jsx",
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          paths: { "@/*": ["./src/*"] },
        },
      },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!(zustand|react-markdown)/)"],
};
