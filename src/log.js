// GitHub Actions workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export const log = {
  info: (message) => console.log(message),
  debug: (message) => console.log(`::debug::${escape(message)}`),
  warning: (message) => console.log(`::warning::${escape(message)}`),
  error: (message) => console.log(`::error::${escape(message)}`),
};
