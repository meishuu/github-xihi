const JsDiff = require('diff');
const GitHub = require('github');

const jwt = require('./jwt')({
  keyFile: process.env['XIHI_KEYFILE'],
  issuer: 2080,
});

const server = require('./server')({
  path: process.env['XIHI_WWW_PATH'],
  secret: process.env['XIHI_SECRET'],
});

const github = new GitHub({
  protocol: 'https',
  host: 'api.github.com',
  timeout: 5 * 1000,
  headers: {
    'user-agent': 'Xihi [Integration 2080]',
  },
  Promise: Promise,
});

function promiseMap(arr, func) {
  return Promise.all(arr.map(val => new Promise((resolve, reject) => {
    func(val, resolve, reject);
  })));
}

async function authenticate() {
  github.authenticate({ type: 'integration', token: jwt() });
  const res = await github.integrations.createInstallationToken({ installation_id: 20524 });
  return res.data.token;
}

function gh(token) {
  github.authenticate({ type: 'token', token });
  return github;
}

function getContent(token, args, required = true) {
  return new Promise((resolve, reject) => {
    gh(token).repos.getContent(args)
    .then((res) => {
      if (res.data.encoding === 'base64') {
        resolve(Buffer.from(res.data.content, 'base64').toString('utf8'));
      } else {
        reject(new Error(`unknown encoding "${res.data.encoding}"`));
      }
    })
    .catch((err) => {
      if (!required && err.code === 404) {
        resolve(null);
        return;
      }

      console.error(`error getting "${args.path}" from ${args.owner}/${args.repo}#${args.ref}`);
      console.error(err);
      reject(err);
    });
  });
}

async function processRef(token, owner, repo, ref, files, pr = false) {
  const [added, modified, removed] =
    [files.added, files.modified, files.removed].map(arr => arr
      .filter(file => file.startsWith('protocol/'))
      .map(file => file.slice('protocol/'.length))
    );

  const notes = {
    newDef: [],
    noPrevious: [],
    unknown: [],
    diffs: [],
  };

  const updated = added.reduce((arr, file) => {
    const match = file.match(/^([^.]+)\.(\d+)\.def$/);
    if (!match) {
      notes.unknown.push(file);
      return arr;
    }

    const name = match[1];
    const version = parseInt(match[2], 10);

    if (version === 1) {
      notes.newDef.push(file);
      return arr;
    }

    arr.push({ name, version });
    return arr;
  }, []);

  try {
    await promiseMap(updated, async (def, resolve, reject) => {
      const oldFile = `protocol/${def.name}.${def.version - 1}.def`;
      const newFile = `protocol/${def.name}.${def.version}.def`;

      let oldData;
      let newData;

      try {
        oldData = await getContent(token, {
          owner,
          repo,
          path: oldFile,
          ref,
        }, false);
      } catch (err) {
        console.error('failed to get old version contents');
        return reject(err);
      }

      if (oldData === null) {
        notes.noPrevious.push(newFile.slice('protocol/'.length));
        return resolve();
      }

      try {
        newData = await getContent(token, {
          owner,
          repo,
          path: newFile,
          ref,
        });
      } catch (err) {
        console.error('failed to get new version contents');
        return reject(err);
      }

      notes.diffs.push({
        name: def.name,
        version: def.version,
        diff: JsDiff.createTwoFilesPatch(
          `a/${oldFile}`,
          `b/${newFile}`,
          oldData,
          newData,
          undefined,
          undefined,
          { context: 3 }
        ).replace(/^=+\n/, ''),
      });

      resolve();
    });
  } catch (err) {
    console.warn('failed to diff contents');
    console.warn(err);
    return;
  }

  //

  function fileList(arr) {
    return (arr
      .sort((a, b) => a.localeCompare(b))
      .map(f => `- \`${f}\``)
    );
  }

  function makeList(header, files) {
    return [header, ...fileList(files)].join('\n');
  }

  // generate summary
  const summary = [];

  if (notes.newDef.length > 0) {
    summary.push(makeList('Added new definition:', notes.newDef));
  }

  if (modified.length > 0) {
    summary.push(makeList('Modified existing version:', modified));
  }

  if (removed.length > 0) {
    summary.push(makeList('Removed:', removed));
  }

  // generate warnings
  const warnings = [];

  if (notes.noPrevious.length > 0) {
    warnings.push(makeList('Previous version not found:', notes.noPrevious));
  }

  if (notes.unknown.length > 0) {
    warnings.push(makeList('Invalid filename format:', notes.unknown));
  }

  // write diffs
  const diffs = notes.diffs
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(f =>
      `### \`${f.name}\` ${f.version - 1} => ${f.version}\n` +
      '```diff\n' + f.diff + '```'
    );

  // exit if not noteworthy
  if (warnings.length === 0 && diffs.length === 0) {
    return null;
  }

  const body = [!pr
    ? 'Version analysis for protocol definitions in this commit:'
    : 'Version analysis for protocol definitions from applying this PR:'
  ];

  if (summary.length > 0) body.push('## Summary', ...summary);
  if (warnings.length > 0) body.push('## Warnings', ...warnings);
  if (diffs.length > 0) body.push('## Diffs', ...diffs);

  return body.join('\n\n');
}

server.on('push', async (data) => {
  console.log(`received push ${data.after} => ${data.ref}`);

  const owner = data.repository.owner.login;
  const repo = data.repository.name;

  let token;

  try {
    token = await authenticate();
  } catch (err) {
    console.error('error creating installation token');
    console.error(err);
    return;
  }

  await promiseMap(data.commits, async (commit, resolve, reject) => {
    const { id } = commit;

    try {
      const body = await processRef(token, owner, repo, id, commit);
      if (body !== null) {
        try {
          const { data } = await gh(token).repos.createCommitComment({
            owner,
            repo,
            sha: id,
            body,
          });
          console.log(`successfully created comment <${data.html_url}>`);
        } catch (err) {
          console.error('failed to make commit comment');
          console.error(err);
        }
      }
    } catch (err) {
      console.error('failed to process commit');
      console.error(err);
    }

    resolve();
  });
});

server.on('pull_request', async (data) => {
  if (data.action !== 'opened' && data.action !== 'synchronize') return;

  const owner = data.repository.owner.login;
  const repo = data.repository.name;
  const number = data.number;
  const ref = data.pull_request.head.sha;

  console.log(`received PR #${number} ${data.action}`);

  let token;

  try {
    token = await authenticate();
  } catch (err) {
    console.error('error creating installation token');
    console.error(err);
    return;
  }

  const files = {
    added: [],
    modified: [],
    removed: [],
  };

  try {
    const { data } = await gh(token).pullRequests.getFiles({ owner, repo, number });
    for (const change of data) {
      const arr = files[change.status];
      if (arr) arr.push(change.filename);
    }
  } catch (err) {
    console.error('error getting PR files');
    console.error(err);
    return;
  }

  const body = await processRef(token, owner, repo, ref, files, true);
  if (body !== null) {
    try {
      const { data } = await gh(token).issues.createComment({ owner, repo, number, body })
      console.log(`successfully created comment <${data.html_url}>`);
    } catch (err) {
      console.error('error creating comment');
      console.error(err);
      return;
    }
  }
});

server.http.listen(process.env['XIHI_WWW_PORT']);
