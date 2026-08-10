import "./ClickMenu.css";

type ClickMenu = "clickMenuOn" | "clickMenuOff";

type ClickMenuProps = {
  menuIsShowing: Boolean;
  hideClickMenu: () => void;
  xPos: number;
  yPos: number;
};

export function ClickMenu({
  menuIsShowing,
  hideClickMenu,
  xPos,
  yPos,
}: ClickMenuProps) {
  return menuIsShowing ? (
    <div id="preventClickCover" onClick={hideClickMenu}>
      <div id="clickMenu" style={{ left: xPos, top: yPos }}>
        <div id="standalonePlay" className="menuItem">
          Standalone Play
        </div>
        <div id="normalPlay" className="menuItem">
          Play from Here
        </div>
        <div id="addToQueue" className="menuItem">
          Add to Queue
        </div>
        <div id="playNext" className="menuItem">
          Play Next
        </div>
      </div>
    </div>
  ) : (
    <></>
  );
}
