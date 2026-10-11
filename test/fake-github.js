// An in-memory stand-in for the GitHub API methods the updater uses.
export class FakeGitHub {
  constructor(files, { defaultBranch = 'main', author = 'github-actions[bot]' } = {}) {
    this.commits = new Map();
    this.branches = new Map();
    this.pulls = [];
    this.comments = [];
    this.reactions = [];
    this.labels = new Set();
    this.dispatched = [];
    this.permissions = { owner: 'admin', reader: 'read' };
    this.releaseData = {};
    this.recent = [];
    this.autoMerge = 'allowed';
    this.defaultBranch = defaultBranch;
    this.author = author;
    this.count = 0;
    this.nextNumber = 1;
    this.branches.set(defaultBranch, this.makeCommit(new Map(Object.entries(files).map(([path, content]) => [path, { content, mode: '100644' }])), null, 'init'));
  }

  makeCommit(tree, parent, message) {
    const sha = `c${++this.count}`.padEnd(40, '0');
    this.commits.set(sha, { tree, parent, message });
    return sha;
  }

  // Test helpers
  push(branch, files, message = 'manual change') {
    const parent = this.branches.get(branch);
    const tree = new Map(this.commits.get(parent).tree);
    for (const [path, content] of Object.entries(files)) tree.set(path, { content, mode: '100644' });
    this.branches.set(branch, this.makeCommit(tree, parent, message));
  }

  file(branch, path) {
    return this.commits.get(this.branches.get(branch))?.tree.get(path)?.content;
  }

  pull(number) {
    return this.pulls.find((pr) => pr.number === number);
  }

  commentsOn(number) {
    return this.comments.filter((comment) => comment.number === number).map((comment) => comment.body);
  }

  view(pr) {
    return structuredClone({ ...pr, headSha: this.branches.get(pr.headRef) ?? pr.headSha });
  }

  // API
  async getRepo() {
    return { defaultBranch: this.defaultBranch, allowMergeCommit: true, allowSquashMerge: true };
  }

  async getBranchHead(branch) {
    const sha = this.branches.get(branch);
    return sha ? { sha, treeSha: `t:${sha}` } : null;
  }

  async branchExists(branch) {
    return this.branches.has(branch);
  }

  async getTree(treeSha) {
    const sha = treeSha.slice(2);
    const entries = [...this.commits.get(sha).tree].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: `b:${sha}:${path}` }));
    return { entries, truncated: false };
  }

  async getBlob(blobSha) {
    const [, sha, path] = /^b:([^:]+):(.*)$/.exec(blobSha);
    return this.commits.get(sha).tree.get(path).content;
  }

  async createCommit({ parent, baseTree, files, message }) {
    const tree = new Map(this.commits.get(baseTree.slice(2)).tree);
    for (const [path, entry] of files) tree.set(path, { content: entry.content, mode: entry.mode });
    return this.makeCommit(tree, parent, message);
  }

  async setBranch(branch, sha) {
    this.branches.set(branch, sha);
  }

  async deleteBranch(branch) {
    for (const pr of this.pulls) if (pr.headRef === branch && this.branches.has(branch)) pr.headSha = this.branches.get(branch);
    this.branches.delete(branch);
  }

  async recentCommits() {
    return this.recent;
  }

  async listPulls() {
    return [...this.pulls].reverse().map((pr) => this.view(pr));
  }

  async getPull(number) {
    return this.view(this.pull(number));
  }

  async createPull({ title, body, head, base }) {
    if (!this.branches.has(head)) throw new Error(`No branch ${head}`);
    if (this.pulls.some((pr) => pr.headRef === head && pr.state === 'open')) throw new Error(`A pull request for ${head} already exists`);
    const number = this.nextNumber++;
    const pr = {
      id: `PR_${number}`,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      url: `https://github.com/o/r/pull/${number}`,
      headRef: head,
      headSha: this.branches.get(head),
      baseRef: base,
      crossRepository: false,
      mergeable: true,
      author: this.author,
      autoMerge: false,
      labels: [],
      assignees: [],
      reviewers: [],
      milestone: null,
    };
    this.pulls.push(pr);
    return this.view(pr);
  }

  async updatePull(number, fields) {
    const pr = this.pull(number);
    if (fields.state === 'open' && !this.branches.has(pr.headRef)) throw new Error('Cannot reopen: the head branch was deleted');
    if (fields.state === 'closed') pr.headSha = this.branches.get(pr.headRef) ?? pr.headSha;
    Object.assign(pr, fields);
  }

  async mergePull(number) {
    Object.assign(this.pull(number), { state: 'closed', merged: true });
  }

  async enableAutoMerge(id) {
    if (this.autoMerge === 'disabled') throw new Error('Pull request Auto merge is not allowed for this repository');
    if (this.autoMerge === 'clean') throw new Error('Pull request Pull request is in clean status');
    this.pulls.find((pr) => pr.id === id).autoMerge = true;
  }

  async disableAutoMerge(id) {
    this.pulls.find((pr) => pr.id === id).autoMerge = false;
  }

  async comment(number, body) {
    this.comments.push({ number, body });
  }

  async react(commentId, content) {
    this.reactions.push({ commentId, content });
  }

  async labelExists(name) {
    return this.labels.has(name);
  }

  async createLabel(name) {
    this.labels.add(name);
  }

  async addLabels(number, labels) {
    this.pull(number).labels.push(...labels);
  }

  async addAssignees(number, assignees) {
    this.pull(number).assignees.push(...assignees);
  }

  async requestReviewers(number, users, teams) {
    this.pull(number).reviewers.push(...users, ...teams.map((team) => `team:${team}`));
  }

  async setMilestone(number, milestone) {
    this.pull(number).milestone = milestone;
  }

  async permission(user) {
    return this.permissions[user] ?? 'none';
  }

  async dispatchWorkflow(workflow, ref) {
    this.dispatched.push(`${workflow}@${ref}`);
  }

  async releases(repository) {
    return this.releaseData[repository] ?? [];
  }
}
