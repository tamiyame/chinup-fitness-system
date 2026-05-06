const Toast = ({ msg, kind = 'info', show }) => (
  <div className={`toast ${show ? 'show' : ''} ${kind}`}>{msg}</div>
);
window.Toast = Toast;
