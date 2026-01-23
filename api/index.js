const app = require('../dist/index.js').default;

module.exports = (req, res) => {
  return app(req, res);
};