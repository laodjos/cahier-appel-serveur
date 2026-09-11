const Sequencer = require("@jest/test-sequencer").default;

class SequenceurAlphabetique extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = SequenceurAlphabetique;
