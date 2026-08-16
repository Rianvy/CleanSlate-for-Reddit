import { browser } from '#imports';
import ReactDOM from 'react-dom/client';
import { t } from '../../src/i18n';
import { GITHUB_REPOSITORY_URL } from '../../src/project';
import './style.css';

function Popup() {
  const openReddit = async (): Promise<void> => {
    await browser.tabs.create({ url: 'https://www.reddit.com/' });
    window.close();
  };

  return (
    <main>
      <header>
        <span className="mark">
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="3" /><rect x="18" y="5" width="9" height="9" rx="3" /><rect x="5" y="18" width="9" height="9" rx="3" /><path d="M19 22.5h7M22.5 19v7" /></svg>
        </span>
        <div><h1>{t('appName')}</h1><p>{t('privacy')}</p></div>
      </header>
      <section className="status">
        <i className="online" />
        <div>
          <strong>{t('sessionMode')}</strong>
          <span>{t('localOnly')}</span>
        </div>
      </section>
      <p className="hint">{t('tagline')}</p>
      <button onClick={() => void openReddit()}>{t('open')} <span>→</span></button>
      <a className="source-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
        <span>&lt;/&gt;</span>{t('sourceCode')}<b>↗</b>
      </a>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Popup />);
