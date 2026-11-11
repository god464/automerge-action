import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/main.ts' },
  minify: true,
  fixedExtension: false,
  deps: {
    alwaysBundle: [/./],
    onlyBundle: [
      '@actions/core',
      'tunnel',
      'undici',
      '@actions/http-client',
      '@actions/io',
      '@actions/exec',
      'universal-user-agent',
      'before-after-hook',
      '@octokit/endpoint',
      'content-type',
      'json-with-bigint',
      '@octokit/request-error',
      '@octokit/request',
      '@octokit/graphql',
      '@octokit/auth-token',
      '@octokit/core',
    ],
  },
});
