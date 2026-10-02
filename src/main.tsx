import { render } from 'preact';
import { App } from './ui/App';
import './ui/global.css';

const root = document.getElementById('app');
if (root) render(<App />, root);
