#!/usr/bin/env node
/** Local submission checks; use --prepublish before the public video is uploaded. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCasePrompt, buildPatrolPrompt } from '../firebase/public/js/prompt.js';
import { offlineCaseText, offlinePatrolText } from '../firebase/public/js/ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
let failures = 0;

function check(name, verify) {
  try {
    verify();
    console.log(`PASS ${name}`);
  } catch {
    failures++;
    console.log(`FAIL ${name}`);
  }
}

const readme = read('README.md');
const html = read('firebase/public/index.html');
const appSource = read('firebase/public/js/app.js');
const promptSource = read('firebase/public/js/prompt.js');

check('README.md has the English project heading', () => {
  assert.match(readme, /^# Training Failure Triage/m);
});
check('README.md names lt020211 - Team Lead and Engineer', () => {
  assert.match(readme, /lt020211\s+-\s+Team Lead and Engineer/);
});
check('README.md links to the live demo', () => {
  assert.match(readme, /https:\/\/gpu-waste-auditor-2026\.web\.app/);
});
check('README.md explains the team attribution boundary', () => {
  assert.match(readme, /Repository attribution does not establish registration eligibility; the application record remains authoritative\./);
});
check('README.md states the current REA and evidence boundary', () => {
  assert.ok(readme.includes('REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.'));
});
check('README.md links to the repository MP4', () => {
  assert.match(readme, /\]\(docs\/Training-Failure-Triage-demo\.mp4\)/);
});
check('README.md records the public Google Drive video publication status', () => {
  assert.match(readme, /Public Google Drive video: (?:upload pending|\[.+\]\(https:\/\/drive\.google\.com\/[^)]+\))/);
});
check('README.md links to the Chinese supplement', () => {
  assert.match(readme, /\]\(README\.zh-CN\.md\)/);
  assert.ok(existsSync(path.join(ROOT, 'README.zh-CN.md')));
});
check('the Chinese supplement links back to the default English README', () => {
  assert.match(read('README.zh-CN.md'), /\]\(README\.md\)/);
});
check('README.en.md directs English readers to README.md', () => {
  assert.match(read('README.en.md'), /\]\(README\.md\)/);
  assert.match(read('README.en.md'), /\]\(README\.zh-CN\.md\)/);
});
for (const file of ['docs/architecture.en.md', 'docs/demo-script.en.md']) {
  check(`${file} states that REA is not included`, () => {
    assert.ok(read(file).includes('REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.'));
  });
}
check('the application declares English', () => {
  assert.match(html, /<html\s+lang="en">/);
});
check('the application uses the English project name', () => {
  assert.match(html, /Training Failure Triage/);
});
check('the application shell contains no Chinese', () => {
  assert.doesNotMatch(html, /[\u3400-\u9fff]/);
});
check('the application uses a fresh English output cache', () => {
  assert.match(appSource, /triage:cache:v3/);
  assert.doesNotMatch(appSource, /triage:cache:v2/);
});
check('model prompts request English responses', () => {
  assert.match(promptSource, /Respond in English/);
  assert.match(buildCasePrompt({}, {}), /Respond in English/);
  assert.match(buildPatrolPrompt({}, '2026-10-15T00:00:00Z'), /Respond in English/);
});
for (const file of ['firebase/public/js/app.js', 'firebase/public/js/prompt.js',
  'firebase/public/js/ai.js', 'firebase/public/styles.css']) {
  check(`${file} contains no Chinese orchestration copy`, () => {
    // This scope has no internal match-data exceptions. Domain catalogs are checked separately.
    assert.doesNotMatch(read(file), /[\u3400-\u9fff]/);
  });
}
check('offline case output is English without a model', () => {
  const text = offlineCaseText({}, {}, {
    classification: 'undetermined', should_rma: false, confidence: 0, actions: [],
  });
  assert.match(text, /Decision \(offline rule baseline\)/);
  assert.doesNotMatch(text, /[\u3400-\u9fff]/);
});
const offlinePatrol = await offlinePatrolText({ listNodes: async () => [] });
check('offline patrol output is English without a model', () => {
  assert.match(offlinePatrol, /Scanned 0 nodes; 0 flagged/);
  assert.doesNotMatch(offlinePatrol, /[\u3400-\u9fff]/);
});
check('the repository demo MP4 exists', () => {
  assert.ok(existsSync(path.join(ROOT, 'docs/Training-Failure-Triage-demo.mp4')));
});

for (const file of ['README.md', 'README.en.md', 'firebase/public/index.html']) {
  const content = read(file);
  for (const token of ['example.com', 'PUBLIC_URL', 'TODO']) {
    check(`${file} contains no ${token} placeholder`, () => {
      assert.ok(!content.includes(token));
    });
  }
  check(`${file} contains no empty Markdown links`, () => {
    assert.doesNotMatch(content, /\]\(\s*\)/);
  });
}

if (!process.argv.includes('--prepublish')) {
  check('README.md contains a concrete Google Drive file viewer/share URL', () => {
    const links = readme.match(/https:\/\/drive\.google\.com\/[^\s<>)\]"']*/g) || [];
    assert.ok(links.some((link) => {
      const url = new URL(link);
      return /^\/file\/d\/[A-Za-z0-9_-]+(?:\/(?:view|preview))?\/?$/.test(url.pathname)
        || (/^\/open\/?$/.test(url.pathname)
          && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('id') || ''));
    }));
  });
}

process.exitCode = failures ? 1 : 0;
