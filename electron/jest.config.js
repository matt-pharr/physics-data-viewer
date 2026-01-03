const path = require('path');

module.exports = {
  preset: 'ts-jest',
  rootDir: __dirname,
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src', '<rootDir>/../tests'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/?(*.)+(test|spec).ts?(x)'],
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy',
  },
  moduleDirectories: ['node_modules', path.join(__dirname, 'node_modules')],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: path.join(__dirname, 'tsconfig.test.json') }],
  },
};
